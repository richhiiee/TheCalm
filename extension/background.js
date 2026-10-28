/* IntroDB access stays in the extension worker, never in the streaming page. */
(function (root) {
  "use strict";
  if (!root.CalmSkip && typeof importScripts === "function") importScripts("shared.js");
  if (typeof importScripts === "function") importScripts("players.js");
  const Core = root.CalmSkip || (typeof require === "function" ? require("./shared.js") : null);
  const MESSAGE_TYPES = new Set(["GET_CONTEXT", "SET_EPISODE", "SET_SETTINGS", "UPDATE_SETTINGS", "SET_MAPPING", "REFRESH_TIMINGS", "IMPORT_TIMINGS", "AUTHORIZE_SKIP", "REPORT_STATUS", "NEXT_EPISODE", "UNDO_SKIP", "PLAYER_COMMAND", "CONNECT_PLAYER", "PLAYER_ORIGINS", "PLAYER_FRAMES_CHANGED"]);
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const MISSING_TTL = 15 * 60 * 1000;
  const SETTINGS_SCHEMA_VERSION = 2;

  function createBackgroundRuntime(chromeApi, fetchImpl = root.fetch.bind(root), options = {}) {
    const clock = options.now || Date.now;
    const timeoutMs = options.timeoutMs || 10000;
    const inflight = new Map();
    const playbackByTab = new Map();
    const contextsByTab = new Map();
    const cacheVersions = new Map();
    const players = options.players || root.CalmPlayers;
    let cacheWriteQueue = Promise.resolve();
    let settingsInitialization;

    function initializeSettings() {
      if (!settingsInitialization) {
        settingsInitialization = (async () => {
          const data = await chromeApi.storage.local.get(["settings", "settingsSchemaVersion"]);
          if (Number.isInteger(data.settingsSchemaVersion) && data.settingsSchemaVersion >= SETTINGS_SCHEMA_VERSION) return;
          const settings = Core.sanitizeSettings(data.settings);
          // Version 0.1 started in review mode. Apply the requested automatic
          // default once on upgrade; later explicit pauses remain untouched.
          settings.enabled = true;
          await chromeApi.storage.local.set({ settings, settingsSchemaVersion: SETTINGS_SCHEMA_VERSION });
        })();
      }
      return settingsInitialization;
    }

    async function readState() {
      await initializeSettings();
      const data = await chromeApi.storage.local.get(["settings", "showMappings", "timingCache"]);
      return { settings: Core.sanitizeSettings(data.settings), mappings: data.showMappings && typeof data.showMappings === "object" ? data.showMappings : {}, cache: data.timingCache && typeof data.timingCache === "object" ? data.timingCache : {} };
    }

    function isPopup(sender) {
      return !sender.tab && sender.id === chromeApi.runtime.id && sender.url === chromeApi.runtime.getURL("popup.html");
    }

    async function getTab(message, sender) {
      const id = sender.tab?.id ?? (isPopup(sender) && message.tabId);
      if (!Number.isInteger(id)) throw new Error("Open an episode on TheCalm first.");
      const tab = await chromeApi.tabs.get(id);
      if (!Core.isCalmUrl(tab.url)) throw new Error("This extension only controls TheCalm tabs.");
      try { players?.trackTab?.(tab); } catch { /* Player discovery must never delay or block episode metadata. */ }
      return tab;
    }

    function requirePopup(sender) {
      if (!isPopup(sender)) throw new Error("This action is available only in the extension popup.");
    }

    async function hasPlayerAccess(sender) {
      if (sender.frameId === 0 || Core.isCalmUrl(sender.url)) return true;
      try {
        const url = new URL(sender.url);
        if (url.protocol !== "https:" || url.username || url.password) return false;
        return Boolean(await chromeApi.permissions?.contains({ origins: [`${url.origin}/*`] }));
      } catch { return false; }
    }

    function inactive(sender) {
      return { ok: true, activeFrameId: null, isActive: false, frameId: sender.frameId };
    }

    async function revokeFrame(tab, sender, playback) {
      if (playbackByTab.get(tab.id)?.frameId === sender.frameId) playbackByTab.delete(tab.id);
      const state = await readState();
      const context = await contextFor(tab, state);
      try {
        await chromeApi.tabs.sendMessage(tab.id, {
          type: "PLAYER_STATUS", frameId: sender.frameId,
          playback: { ...playback, episodeKey: contentEpisodeKey(context), hasVideo: false, visible: false, paused: true, area: 0, canUndo: false },
        }, { frameId: 0 });
      } catch { /* No top-page script means no active player can be authorized. */ }
      return inactive(sender);
    }

    async function notifyTab(tabId) {
      try { await chromeApi.tabs.sendMessage(tabId, { type: "CONTEXT_UPDATED" }); } catch { /* The content script may not be installed yet. */ }
    }

    async function notifyAllTabs() {
      const tabs = await chromeApi.tabs.query({ url: ["https://thecalm.site/*", "https://www.thecalm.site/*"] });
      await Promise.all(tabs.map(tab => notifyTab(tab.id)));
    }

    function rawProjection(data) {
      if (!data) return null;
      const raw = { imdb_id: data.imdbId, media_type: "tv", is_movie: false, season: data.season, episode: data.episode };
      for (const type of Core.SEGMENT_TYPES) {
        const segment = data.segments[type];
        raw[type] = segment ? { start_sec: segment.start, end_sec: segment.end, confidence: segment.confidence, submission_count: segment.submissionCount } : null;
      }
      raw.post_credits = data.postCredits ? { start_sec: data.postCredits.start, end_sec: data.postCredits.end, confidence: data.postCredits.confidence, submission_count: data.postCredits.submissionCount } : null;
      return raw;
    }

    async function storeCache(key, entry) {
      // Chrome storage read/modify/write is not atomic: serialize independent lookups.
      const write = cacheWriteQueue.catch(() => {}).then(async () => {
        const stored = await chromeApi.storage.local.get("timingCache");
        const cache = stored.timingCache && typeof stored.timingCache === "object" ? stored.timingCache : {};
        for (const [cacheKey, value] of Object.entries(cache)) if (!value || value.expiresAt <= clock()) delete cache[cacheKey];
        cache[key] = entry;
        const sortedKeys = Object.keys(cache).sort((a, b) => (cache[b]?.fetchedAt || 0) - (cache[a]?.fetchedAt || 0));
        for (const oldKey of sortedKeys.slice(100)) delete cache[oldKey];
        await chromeApi.storage.local.set({ timingCache: cache });
      });
      cacheWriteQueue = write;
      await write;
    }

    function cacheResult(cached, context) {
      if (!(cached?.expiresAt > clock()) || cached.schema !== 1) return null;
      try {
        const timings = cached.raw ? Core.validateTimings(cached.raw, context) : null;
        return { timings, status: timings?.hasData ? "ready" : "missing", source: cached.source, fetchedAt: cached.fetchedAt };
      } catch { return null; }
    }

    async function fetchTimings(context, refresh = false) {
      const key = Core.episodeKey(context);
      if (!key) return { timings: null, status: "unidentified" };
      const state = await readState();
      const cachedResult = !refresh && cacheResult(state.cache[key], context);
      if (cachedResult) return cachedResult;
      if (inflight.has(key)) return inflight.get(key);
      const version = cacheVersions.get(key) || 0;
      const operation = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const query = new URLSearchParams({ imdb_id: context.imdbId, season: String(context.season), episode: String(context.episode) });
          const response = await fetchImpl(`https://api.introdb.app/segments?${query}`, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
          if (![200, 204, 404].includes(response.status)) throw new Error(`IntroDB returned HTTP ${response.status}. Try again later.`);
          let timings = null;
          if (response.status === 200) {
            const text = await response.text();
            if (text.length > 128000) throw new Error("IntroDB's response was unexpectedly large.");
            let raw;
            try { raw = JSON.parse(text); } catch { throw new Error("IntroDB returned an invalid JSON response."); }
            timings = Core.validateTimings(raw, context);
          }
          const fetchedAt = clock();
          const hasData = Boolean(timings?.hasData);
          if ((cacheVersions.get(key) || 0) !== version) {
            const latest = await readState();
            return cacheResult(latest.cache[key], context) || { timings: null, status: "missing" };
          }
          await storeCache(key, { schema: 1, source: "IntroDB", fetchedAt, expiresAt: fetchedAt + (hasData ? CACHE_TTL : MISSING_TTL), raw: rawProjection(timings) });
          return { timings, status: hasData ? "ready" : "missing", source: "IntroDB", fetchedAt };
        } catch (error) {
          if ((cacheVersions.get(key) || 0) !== version) {
            const latest = await readState();
            const imported = cacheResult(latest.cache[key], context);
            if (imported) return imported;
          }
          return { timings: null, status: "error", error: controller.signal.aborted ? "IntroDB did not respond in time. Try again." : (error instanceof TypeError ? "Could not reach IntroDB. Check your connection and try again." : error.message) };
        } finally { clearTimeout(timeout); }
      })();
      inflight.set(key, operation);
      try { return await operation; } finally { inflight.delete(key); }
    }

    async function contextFor(tab, state) {
      const parsed = Core.resolveEpisode(tab.url, state.mappings);
      if (!parsed) return null;
      const remembered = contextsByTab.get(tab.id);
      if (remembered && remembered.slug === parsed.slug && remembered.season === parsed.season && remembered.episode === parsed.episode && !parsed.imdbId) parsed.imdbId = remembered.imdbId;
      return parsed;
    }

    function contentEpisodeKey(context) {
      return context ? `${context.slug}:${context.season}:${context.episode}:${context.imdbId || ""}` : "";
    }

    async function getContext(tab, refresh = false, attempt = 0) {
      const state = await readState();
      const context = await contextFor(tab, state);
      if (!context?.imdbId) return { ok: true, context, timings: null, settings: state.settings, status: "unidentified", playback: playbackByTab.get(tab.id) || null };
      const result = await fetchTimings(context, refresh);
      const latestState = await readState();
      const currentTab = await chromeApi.tabs.get(tab.id);
      const currentContext = Core.isCalmUrl(currentTab.url) ? await contextFor(currentTab, latestState) : null;
      // A slow provider request can span a client-side episode change. Return
      // the new episode's data instead of reviving the previous frame context.
      if (contentEpisodeKey(currentContext) !== contentEpisodeKey(context)) {
        if (attempt < 2 && currentContext) return getContext(currentTab, false, attempt + 1);
        return { ok: false, retryable: true, error: "The episode changed while its timings loaded. Reconnecting now." };
      }
      return { ok: true, context, settings: latestState.settings, playback: playbackByTab.get(tab.id) || null, ...result };
    }

    function automaticSettingAllows(settings, type) {
      return settings.enabled && (
        (type === "intro" && settings.skipIntro) ||
        (type === "recap" && settings.skipRecap) ||
        (type === "outro" && settings.autoNext)
      );
    }

    async function authorizeSkip(message, sender, tab) {
      const deny = reason => ({ ok: true, authorized: false, reason });
      if (!sender.tab || !Number.isInteger(sender.frameId)) return deny("Automatic skips must come from the current player.");
      if (!Core.SEGMENT_TYPES.includes(message.segmentType)) return deny("No supported skip segment was selected.");
      if (!Number.isFinite(message.currentTime) || message.currentTime < 0 || !Number.isFinite(message.duration) || message.duration <= 0) {
        return deny("Waiting for valid playback time and duration.");
      }
      const state = await readState();
      const context = await contextFor(tab, state);
      const key = contentEpisodeKey(context);
      if (!context?.imdbId || message.episodeKey !== key) return deny("The episode changed. Waiting for its own timings.");
      if (!automaticSettingAllows(state.settings, message.segmentType)) return deny("Automatic skipping is paused for this segment.");
      if (!await hasPlayerAccess(sender)) return deny("Player access is no longer granted.");

      // Playback actions are checked at the boundary, not against a constantly
      // renewed heartbeat lease. A cached response is normally already present
      // from GET_CONTEXT, and no top-page arbitration round trip is required.
      const result = cacheResult(state.cache[Core.episodeKey(context)], context) || await fetchTimings(context);
      if (result.status !== "ready" || !result.timings) return deny(result.error || "No skip timings are available for this episode.");

      // A provider lookup can outlive a navigation, pause, import, or permission
      // change. Recheck the authoritative tab and settings before authorizing.
      if (!await hasPlayerAccess(sender)) return deny("Player access is no longer granted.");
      if (sender.frameId > 0 && players?.isVisibleFrame) {
        let visible = false;
        try { visible = await players.isVisibleFrame(tab.id, sender.frameId); } catch { /* Removed or inaccessible frames remain inactive. */ }
        if (!visible) return deny("This player is no longer visible.");
      }
      const currentTab = await chromeApi.tabs.get(tab.id);
      const latestState = await readState();
      const currentContext = Core.isCalmUrl(currentTab.url) ? await contextFor(currentTab, latestState) : null;
      if (!currentContext || contentEpisodeKey(currentContext) !== key) return deny("The episode changed. Waiting for its own timings.");
      if (!automaticSettingAllows(latestState.settings, message.segmentType)) return deny("Automatic skipping is paused for this segment.");
      const latest = cacheResult(latestState.cache[Core.episodeKey(currentContext)], currentContext) || result;
      const safety = Core.assessTimings(latest.timings, message.duration, message.segmentType);
      if (!safety.safe) return deny(safety.reason);
      const segment = latest.timings.segments[message.segmentType];
      if (!segment || message.currentTime < segment.start || message.currentTime >= segment.end - 0.05) return deny("Playback is outside this skip segment.");
      return { ok: true, authorized: true, episodeKey: key, segment: { ...segment } };
    }

    async function dispatch(message, sender) {
      try {
        if (!message || !MESSAGE_TYPES.has(message.type)) return undefined;
        if (sender.id !== chromeApi.runtime.id) throw new Error("Unrecognized extension sender.");
        if (["CONNECT_PLAYER", "PLAYER_ORIGINS"].includes(message.type)) {
          requirePopup(sender);
          if (!root.CalmPlayers?.handleMessage) throw new Error("Embedded-player support is unavailable.");
          return await root.CalmPlayers.handleMessage(message, sender);
        }
        if (["SET_SETTINGS", "UPDATE_SETTINGS"].includes(message.type)) {
          requirePopup(sender);
          const state = await readState();
          const settings = Core.sanitizeSettings({ ...state.settings, ...message.settings });
          await chromeApi.storage.local.set({ settings });
          await notifyAllTabs();
          return { ok: true, settings };
        }
        if (message.type === "SET_MAPPING") {
          requirePopup(sender);
          const tab = await getTab(message, sender);
          const currentEpisode = Core.parseEpisodeUrl(tab.url);
          const imdbId = Core.normalizeImdbId(message.imdbId);
          if (typeof message.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(message.slug) || !imdbId) throw new Error("Enter a valid show IMDb ID, such as tt0455275.");
          if (!currentEpisode || currentEpisode.slug !== message.slug) throw new Error("The show changed. Reopen the extension popup.");
          const state = await readState();
          await chromeApi.storage.local.set({ showMappings: { ...state.mappings, [message.slug]: imdbId } });
          await notifyAllTabs();
          return { ok: true, imdbId };
        }
        const tab = await getTab(message, sender);
        if (message.type === "PLAYER_FRAMES_CHANGED") {
          if (!sender.tab || sender.frameId !== 0 || !Core.parseEpisodeUrl(tab.url)) throw new Error("Only the main episode page can reconnect its players.");
          await players?.reconnectTab?.(tab.id);
          return { ok: true };
        }
        if (message.type === "SET_EPISODE") {
          if (!sender.tab || sender.frameId !== 0) throw new Error("Only the main TheCalm page can select an episode.");
          const actual = Core.parseEpisodeUrl(tab.url);
          const requested = Core.parseEpisodeUrl(message.url);
          if (!actual || !requested || JSON.stringify(actual) !== JSON.stringify(requested)) throw new Error("The episode changed. Reload the player context.");
          const state = await readState();
          const context = Core.resolveEpisode(tab.url, state.mappings, message.imdbId);
          const previous = contextsByTab.get(tab.id);
          const changed = contentEpisodeKey(previous) !== contentEpisodeKey(context);
          contextsByTab.set(tab.id, context);
          if (!Object.hasOwn(state.mappings, context.slug) && Core.normalizeImdbId(message.imdbId)) {
            await chromeApi.storage.local.set({ showMappings: { ...state.mappings, [context.slug]: Core.normalizeImdbId(message.imdbId) } });
          }
          // Revoke stale frame context before a slow provider lookup can complete.
          if (changed) await notifyTab(tab.id);
          return await getContext(tab);
        }
        if (message.type === "GET_CONTEXT") return await getContext(tab);
        if (message.type === "AUTHORIZE_SKIP") return await authorizeSkip(message, sender, tab);
        if (message.type === "REFRESH_TIMINGS") {
          if (!isPopup(sender) && sender.frameId !== 0) throw new Error("Refresh timings from the extension popup.");
          const result = await getContext(tab, true);
          await notifyTab(tab.id);
          return result;
        }
        if (message.type === "IMPORT_TIMINGS") {
          requirePopup(sender);
          const state = await readState();
          const context = await contextFor(tab, state);
          if (!context?.imdbId) throw new Error("Identify this show's IMDb ID before importing timestamps.");
          let raw = message.data;
          if (typeof raw === "string") {
            if (raw.length > 128000) throw new Error("The imported response is too large.");
            try { raw = JSON.parse(raw); } catch { throw new Error("Paste a valid IntroDB JSON response."); }
          }
          const timings = Core.validateTimings(raw, context);
          const fetchedAt = clock();
          const key = Core.episodeKey(context);
          cacheVersions.set(key, (cacheVersions.get(key) || 0) + 1);
          await storeCache(key, { schema: 1, source: "IntroDB import", fetchedAt, expiresAt: fetchedAt + (timings.hasData ? CACHE_TTL : MISSING_TTL), raw: rawProjection(timings) });
          await notifyTab(tab.id);
          return await getContext(tab);
        }
        if (message.type === "REPORT_STATUS") {
          if (!sender.tab) throw new Error("Playback status must come from a TheCalm player.");
          const playback = message.playback && typeof message.playback === "object" ? message.playback : {};
          if (!await hasPlayerAccess(sender)) return revokeFrame(tab, sender, playback);
          if (sender.frameId > 0 && players?.isVisibleFrame) {
            let visible = false;
            try { visible = await players.isVisibleFrame(tab.id, sender.frameId); } catch { /* Missing frames are inactive. */ }
            if (!visible) return revokeFrame(tab, sender, playback);
          }
          const state = await readState();
          const context = await contextFor(tab, state);
          if (!context || playback.episodeKey !== contentEpisodeKey(context)) {
            return inactive(sender);
          }
          const record = { ...playback, frameId: sender.frameId };
          playbackByTab.set(tab.id, record);
          try { return { ok: true, ...await chromeApi.tabs.sendMessage(tab.id, { type: "PLAYER_STATUS", frameId: sender.frameId, playback: record }, { frameId: 0 }) }; }
          catch { return inactive(sender); }
        }
        if (message.type === "NEXT_EPISODE") {
          if (!sender.tab) throw new Error("Next episode requests must come from the player.");
          if (!await hasPlayerAccess(sender)) throw new Error("Player access is no longer granted. Playback will continue.");
          if (sender.frameId > 0 && players?.isVisibleFrame && !await players.isVisibleFrame(tab.id, sender.frameId)) throw new Error("This player is no longer visible. Playback will continue.");
          const state = await readState();
          if (message.automatic && (!state.settings.enabled || !state.settings.autoNext)) throw new Error("Automatic next episode is paused. Playback will continue.");
          const context = await contextFor(tab, state);
          if (!context || message.episodeKey !== contentEpisodeKey(context)) throw new Error("The episode changed. Playback will continue without advancing.");
          return await chromeApi.tabs.sendMessage(tab.id, { type: "NEXT_EPISODE", automatic: Boolean(message.automatic), episodeKey: message.episodeKey }, { frameId: 0 });
        }
        if (message.type === "UNDO_SKIP") {
          requirePopup(sender);
          return await chromeApi.tabs.sendMessage(tab.id, { type: "UNDO_SKIP" }, { frameId: 0 });
        }
        if (message.type === "PLAYER_COMMAND") {
          const commands = { UNDO_SKIP: "UNDO_SKIP_DIRECT", GET_PLAYER_STATUS: "GET_PLAYER_STATUS_DIRECT" };
          if (!sender.tab || sender.frameId !== 0 || !Object.hasOwn(commands, message.command) || !Number.isInteger(message.frameId) || message.frameId < 0) throw new Error("Invalid player command.");
          return await chromeApi.tabs.sendMessage(tab.id, { type: commands[message.command] }, { frameId: message.frameId });
        }
      } catch (error) { return { ok: false, error: error?.message || "The extension could not complete this action." }; }
    }

    function install() {
      chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!MESSAGE_TYPES.has(message?.type)) return false;
        dispatch(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
        return true;
      });
      chromeApi.tabs.onRemoved?.addListener(tabId => { playbackByTab.delete(tabId); contextsByTab.delete(tabId); });
      chromeApi.tabs.onUpdated?.addListener((tabId, info) => { if (info.url) { playbackByTab.delete(tabId); contextsByTab.delete(tabId); } });
    }

    return { dispatch, install, fetchTimings };
  }

  if (typeof module === "object" && module.exports) module.exports = { createBackgroundRuntime, CACHE_TTL, MISSING_TTL, SETTINGS_SCHEMA_VERSION };
  if (root.chrome?.runtime?.onMessage) createBackgroundRuntime(root.chrome).install();
})(globalThis);
