/* Runs in an isolated world on TheCalm and in explicitly connected player frames. */
(() => {
  "use strict";
  if (globalThis.__calmSkipController) return;
  globalThis.__calmSkipController = true;
  const Core = globalThis.CalmSkip;
  const isTop = window === window.top;
  const state = {
    response: null, epoch: 0, url: "", video: null,
    handled: new Set(), undo: null, toast: null, countdown: null,
    players: new Map(), activeFrameId: null,
    lastReport: 0, reportPending: false, lastAction: "", overlay: null,
    refreshSequence: 0, videos: [], bindings: new WeakMap(),
    discoveryActive: false, observers: [], videoEvents: new Map(), selectionDirty: true,
    tickQueued: false, uiTimer: null, retryTimer: null, actionPending: null,
    denial: null, forceReport: false, lastBlockReason: "",
    contextRetryTimer: null, contextRetryAttempt: 0, contextFailed: false,
    frameReconnectTimer: null, frameReconnectForce: false, frameReconnectSignature: null, frameEvents: new Map(),
  };

  async function message(type, fields = {}) {
    try { return await chrome.runtime.sendMessage({ type, ...fields }); }
    catch { return { ok: false, error: "Reload this page to reconnect CalmSkip." }; }
  }

  function extractImdb() {
    // Only primary structured metadata is trusted; recommendation links are deliberately ignored.
    const find = (node) => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        const media = node.filter(item => /^(TVSeries|TVEpisode|Movie)$/.test(String(item?.["@type"])));
        return media.length === 1 ? find(media[0]) : null;
      }
      if (node["@graph"]) return find(node["@graph"]);
      if (node.partOfSeries) return find(node.partOfSeries);
      if (!/^(TVSeries|TVEpisode|Movie)$/.test(String(node["@type"]))) return null;
      const values = [node.imdb_id, node.imdbId, node.url, node.identifier?.value, node.identifier, ...(Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs])];
      return values.map(value => Core.normalizeImdbId(value)).find(Boolean) || null;
    };
    const found = new Set();
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { const id = find(JSON.parse(script.textContent)); if (id) found.add(id); } catch { /* Malformed page metadata is ignored. */ }
    }
    for (const meta of document.querySelectorAll('meta[property="imdb:id"],meta[name="imdb_id"]')) {
      const id = Core.normalizeImdbId(meta.content); if (id) found.add(id);
    }
    return found.size === 1 ? [...found][0] : null;
  }

  function episodeIdentity(response = state.response) {
    const context = response?.context;
    return context ? `${context.slug}:${context.season}:${context.episode}:${context.imdbId || ""}` : "";
  }

  function mediaEpisodeIdentity() {
    const context = state.response?.context;
    return context ? `${context.slug}:${context.season}:${context.episode}` : "";
  }

  function resetEpisode() {
    state.handled.clear(); state.undo = null; state.toast = null; state.countdown = null;
    state.lastAction = ""; state.activeFrameId = null; state.actionPending = null; state.denial = null;
    clearTimeout(state.uiTimer); clearTimeout(state.retryTimer);
    clearTimeout(state.contextRetryTimer); state.contextRetryTimer = null;
    state.contextRetryAttempt = 0; state.contextFailed = false;
    state.players.clear();
  }

  function retryContext() {
    if (state.contextRetryTimer || state.contextRetryAttempt >= 5 || (isTop && !Core.parseEpisodeUrl(location.href))) return;
    const epoch = state.epoch;
    const delay = Math.min(60000, 3000 * 2 ** state.contextRetryAttempt++);
    state.contextRetryTimer = setTimeout(() => {
      state.contextRetryTimer = null;
      if (epoch === state.epoch && state.contextFailed) refreshContext();
    }, delay);
  }

  async function refreshContext(select = false) {
    const epoch = state.epoch;
    const sequence = ++state.refreshSequence;
    // A resource may finish loading before the next episode's timings arrive.
    // Bind only metadata that existed when this authoritative request began;
    // never attach a newly loaded resource to the previous cached response.
    const pendingMedia = state.videos.map(video => ({ video, binding: state.bindings.get(video) }))
      .filter(({ binding }) => binding?.pendingContext && !binding.awaitingMetadata);
    const response = await message(select && isTop ? "SET_EPISODE" : "GET_CONTEXT", select && isTop ? { url: location.href, imdbId: extractImdb() } : {});
    if (epoch !== state.epoch || sequence !== state.refreshSequence) return;
    if (!response?.ok) { state.contextFailed = true; state.lastBlockReason = response?.error || "Waiting to reconnect episode timings."; retryContext(); return; }
    if (isTop) {
      const current = Core.parseEpisodeUrl(location.href);
      const context = response.context;
      if (!current || !context || current.slug !== context.slug || current.season !== context.season || current.episode !== context.episode) {
        const observedEpoch = state.epoch;
        checkNavigation();
        if (current && observedEpoch === state.epoch) { state.contextFailed = true; retryContext(); }
        return;
      }
    }
    if (episodeIdentity(response) !== episodeIdentity()) resetEpisode();
    state.response = response;
    for (const { video, binding } of pendingMedia) {
      if (video.isConnected && state.bindings.get(video) === binding) {
        binding.episode = mediaEpisodeIdentity() || null; binding.pendingContext = false;
      }
    }
    startDiscovery();
    state.contextFailed = response.status === "error";
    if (state.contextFailed) retryContext();
    else { clearTimeout(state.contextRetryTimer); state.contextRetryTimer = null; state.contextRetryAttempt = 0; }
    if (!response.settings.enabled) state.countdown = null;
    state.forceReport = true;
    scheduleTick();
  }

  function checkNavigation() {
    if (!isTop) return;
    const current = Core.parseEpisodeUrl(location.href);
    const key = current ? `${current.slug}:${current.season}:${current.episode}` : "";
    if (key === state.url) return;
    state.url = key; state.epoch++; state.response = null; resetEpisode(); render();
    if (current) refreshContext(true);
    else stopDiscovery();
  }

  function scheduleTick() {
    if (state.tickQueued) return;
    state.tickQueued = true;
    queueMicrotask(() => { state.tickQueued = false; tick(); });
  }

  function scheduleFrameReconnect(force = false) {
    if (!isTop || !Core.parseEpisodeUrl(location.href)) return;
    state.frameReconnectForce ||= force;
    if (state.frameReconnectTimer) return;
    state.frameReconnectTimer = setTimeout(() => {
      state.frameReconnectTimer = null;
      const force = state.frameReconnectForce; state.frameReconnectForce = false;
      if (!Core.parseEpisodeUrl(location.href)) return;
      // Cosmetic iframe animations must not restart worker discovery. Measure
      // only after coalescing events, and ignore changes in area or position.
      const signature = JSON.stringify(frameCandidates().map(({ url, visible, frameIndex }) => ({ url, visible, frameIndex })).sort((a, b) => a.frameIndex - b.frameIndex));
      if (!force && signature === state.frameReconnectSignature) return;
      state.frameReconnectSignature = signature; message("PLAYER_FRAMES_CHANGED");
    }, 250);
  }

  function watchFrame(frame) {
    if (!isTop || state.frameEvents.has(frame)) return;
    const abort = new AbortController();
    const observer = new MutationObserver(records => scheduleFrameReconnect(records.some(record => record.attributeName === "src")));
    observer.observe(frame, { attributes: true, attributeFilter: ["src", "hidden", "style", "class"] });
    state.frameEvents.set(frame, { abort, observer });
    frame.addEventListener("load", () => scheduleFrameReconnect(true), { signal: abort.signal });
    scheduleFrameReconnect(true);
  }

  function watchVideo(video) {
    if (state.videoEvents.has(video)) return;
    const abort = new AbortController();
    state.videoEvents.set(video, abort); state.videos.push(video);
    const onMedia = event => {
      if (["emptied", "loadstart"].includes(event.type)) {
        state.bindings.set(video, { episode: null, awaitingMetadata: true, pendingContext: true });
        if (video === state.video) { state.handled.clear(); state.undo = null; state.toast = null; state.countdown = null; state.actionPending = null; }
      }
      if (event.type === "loadedmetadata") {
        state.bindings.set(video, { episode: null, awaitingMetadata: false, pendingContext: true });
        checkNavigation(); refreshContext();
      }
      if (event.type === "play" && state.contextFailed) { clearTimeout(state.contextRetryTimer); state.contextRetryTimer = null; refreshContext(); }
      if (event.type !== "timeupdate") { state.selectionDirty = true; state.forceReport = true; }
      scheduleTick();
    };
    for (const type of ["loadedmetadata", "durationchange", "play", "playing", "pause", "timeupdate", "seeking", "seeked", "emptied", "loadstart", "ended"]) video.addEventListener(type, onMedia, { signal: abort.signal });
    // A replacement video element can have loaded before its added subtree is
    // observed. It needs the same current-context check as loadedmetadata.
    state.bindings.set(video, { episode: null, awaitingMetadata: video.readyState < 1, pendingContext: true });
    if (video.readyState >= 1 && video.duration > 60) refreshContext();
    state.selectionDirty = true;
  }

  function visitAdded(node) {
    if (![1, 9, 11].includes(node.nodeType)) return false;
    let changed = false;
    const inspect = element => {
      if (element.id === "thecalm-skip-overlay") return;
      if (element.localName === "video" && !state.videoEvents.has(element)) { watchVideo(element); changed = true; }
      if (element.localName === "iframe") watchFrame(element);
      if (element.shadowRoot && !state.observers.some(item => item.root === element.shadowRoot)) {
        observeRoot(element.shadowRoot);
        changed = visitAdded(element.shadowRoot) || changed;
      }
    };
    if (node.nodeType === 1) inspect(node);
    // One initial walk, then only added subtrees. Text changes never rescan the page.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let element = walker.nextNode(); element; element = walker.nextNode()) inspect(element);
    return changed;
  }

  function observeRoot(root) {
    const observer = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        for (const node of record.addedNodes) changed = visitAdded(node) || changed;
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1) continue;
          for (const [frame, record] of state.frameEvents) {
            if (!frame.isConnected) { record.abort.abort(); record.observer.disconnect(); state.frameEvents.delete(frame); }
          }
          for (const video of [...state.videos]) {
            if (node === video || node.contains(video) || !video.isConnected) {
              state.videoEvents.get(video)?.abort(); state.videoEvents.delete(video);
              state.videos = state.videos.filter(item => item !== video); changed = true;
            }
          }
        }
      }
      state.observers = state.observers.filter(item => {
        if (item.root.host && !item.root.host.isConnected) { item.observer.disconnect(); return false; }
        return true;
      });
      if (changed) { state.selectionDirty = true; state.forceReport = true; scheduleTick(); }
    });
    observer.observe(root, { childList: true, subtree: true });
    state.observers.push({ root, observer });
  }

  function startDiscovery() {
    if (state.discoveryActive) return;
    state.discoveryActive = true; observeRoot(document); visitAdded(document);
    state.selectionDirty = true;
  }

  function stopDiscovery() {
    for (const item of state.observers) item.observer.disconnect();
    for (const abort of state.videoEvents.values()) abort.abort();
    for (const record of state.frameEvents.values()) { record.abort.abort(); record.observer.disconnect(); }
    state.frameEvents.clear(); clearTimeout(state.frameReconnectTimer); state.frameReconnectTimer = null;
    state.frameReconnectForce = false; state.frameReconnectSignature = null;
    state.observers = []; state.videoEvents.clear(); state.videos = []; state.video = null;
    state.discoveryActive = false; state.selectionDirty = true;
    clearTimeout(state.uiTimer); clearTimeout(state.retryTimer);
    clearTimeout(state.contextRetryTimer); state.contextRetryTimer = null;
  }

  function geometry(video) {
    if (!video?.isConnected) return { visible: false, area: 0 };
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    return { visible: rect.width >= 80 && rect.height >= 45 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && !video.hidden && ancestorsVisible(video),
      area: Math.max(0, rect.width * rect.height), rect };
  }

  function ancestorsVisible(element) {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function selectVideo() {
    if (!state.selectionDirty && state.video?.isConnected) return;
    state.selectionDirty = false;
    const candidates = state.videos.filter(video => geometry(video).visible && Number.isFinite(video.duration) && video.duration > 60);
    candidates.sort((a, b) => Number(!b.paused) - Number(!a.paused) || geometry(b).area - geometry(a).area);
    const video = candidates[0] || null;
    if (video === state.video) return;
    state.video = video; state.handled.clear(); state.undo = null; state.toast = null; state.countdown = null; state.lastReport = 0;
    state.actionPending = null; state.denial = null;
    if (video) {
      let binding = state.bindings.get(video);
      if (!binding) {
        binding = { episode: mediaEpisodeIdentity() || null, awaitingMetadata: video.readyState < 1, pendingContext: false };
        state.bindings.set(video, binding);
      }
    }
  }

  function mediaMatchesEpisode() {
    const binding = state.video && state.bindings.get(state.video);
    if (!binding || binding.awaitingMetadata || binding.pendingContext || !mediaEpisodeIdentity()) return false;
    if (!binding.episode) binding.episode = mediaEpisodeIdentity();
    return binding.episode === mediaEpisodeIdentity();
  }

  function safety(segment) {
    if (state.video && !mediaMatchesEpisode()) return { safe: false, reason: "Waiting for this episode's player to load. Reload the episode if its video did not change." };
    return Core.assessTimings(state.response?.timings, state.video?.duration, segment);
  }
  function playback() {
    const video = state.video;
    const safe = safety();
    const dimensions = geometry(video);
    return { hasVideo: Boolean(video), duration: Number.isFinite(video?.duration) ? video.duration : null,
      currentTime: video?.currentTime || 0, paused: video?.paused ?? true,
      visible: dimensions.visible, area: dimensions.area, canUndo: Boolean(state.undo),
      safety: { ok: safe.safe, reason: safe.reason }, lastAction: state.lastAction, episodeKey: episodeIdentity() };
  }

  function choosePlayer() {
    const now = Date.now();
    const candidates = [...state.players.entries()].filter(([, player]) => (now - player.receivedAt < 30000 || player.paused) && player.hasVideo && player.visible && player.episodeKey === episodeIdentity());
    candidates.sort(([idA, a], [idB, b]) => Number(Boolean(b.safety?.ok)) - Number(Boolean(a.safety?.ok)) || Number(!b.paused) - Number(!a.paused) || b.area - a.area || idA - idB);
    state.activeFrameId = candidates[0]?.[0] ?? null;
    return state.activeFrameId;
  }

  async function report(force = false) {
    if (state.reportPending || !state.response?.context || (!force && Date.now() - state.lastReport < 15000)) return;
    state.lastReport = Date.now(); state.reportPending = true;
    await message("REPORT_STATUS", { playback: playback() });
    state.reportPending = false;
  }

  async function authorizeAndSkip(segment) {
    const key = segmentKey(segment);
    if (state.actionPending || (state.denial?.key === key && Date.now() < state.denial.retryAt)) return;
    const pending = { key, epoch: state.epoch, episode: episodeIdentity(), video: state.video };
    state.actionPending = pending;
    const result = await message("AUTHORIZE_SKIP", { episodeKey: pending.episode, segmentType: segment.type, currentTime: pending.video.currentTime, duration: pending.video.duration });
    if (state.actionPending !== pending) return;
    state.actionPending = null;
    const video = state.video;
    if (pending.epoch !== state.epoch || pending.episode !== episodeIdentity() || video !== pending.video || !state.response?.settings.enabled || video.paused || video.seeking || !mediaMatchesEpisode()) return;
    const current = Core.segmentAt(state.response.timings, video.currentTime, state.response.settings);
    if (!current || segmentKey(current) !== key || !safety(current).safe || state.handled.has(key)) return;
    if (result?.authorized === true && (!result.segment || segmentKey(result.segment) !== key)) {
      state.lastBlockReason = "The episode timings changed. Refreshing them now.";
      refreshContext(); return;
    }
    if (result?.authorized !== true || result.episodeKey !== pending.episode || !geometry(video).visible) {
      state.lastBlockReason = result?.reason || result?.error || "Waiting for permission to control this player.";
      state.denial = { key, retryAt: Date.now() + 1500 };
      clearTimeout(state.retryTimer); state.retryTimer = setTimeout(scheduleTick, 1520);
      return;
    }
    state.lastBlockReason = ""; state.denial = null;
    if (current.type === "outro") beginNext(current, true);
    else skip(current);
  }

  function segmentKey(segment) { return `${segment.type}:${segment.start}:${segment.end}`; }

  function skip(segment) {
    if (!state.video || !mediaMatchesEpisode() || segment.type === "outro") return;
    state.handled.add(segmentKey(segment));
    const before = state.video.currentTime;
    try {
      state.video.currentTime = Math.min(segment.end, state.video.duration);
      state.undo = { time: before, segment: segmentKey(segment), video: state.video, episode: episodeIdentity() };
      state.lastAction = `Skipped ${segment.type}`;
      state.toast = { text: state.lastAction, expires: Date.now() + 3000 };
    } catch { state.lastAction = "This player did not allow seeking."; }
    state.lastReport = 0; report(); render();
  }

  function undo() {
    const undo = state.undo;
    if (!undo || undo.video !== state.video || undo.episode !== episodeIdentity()) return { ok: false, error: "There is no skip to undo in this episode." };
    state.countdown = null; state.handled.add(undo.segment);
    state.video.currentTime = undo.time; state.undo = null;
    state.lastAction = "Skip undone"; state.toast = { text: "Skip undone", expires: Date.now() + 3000 };
    state.lastReport = 0; report(); render();
    return { ok: true };
  }

  const NEXT_CONTINUATION_KEY = "__thecalmSkipNextEpisode_v1";
  let nextNavigation = null;

  function episodeRoots() {
    return [document, ...state.observers.map(item => item.root).filter(root => root !== document && root.host?.isConnected)];
  }

  function playerChoice(value) {
    try {
      const choice = new URL(value, location.href).searchParams.get("pl");
      return /^(?:0|[1-9]\d?)$/.test(choice || "") ? choice : null;
    } catch { return null; }
  }

  function episodePlaybackUrl(value, base = location.href, preferredPlayer = playerChoice(location.href)) {
    const url = new URL(value, base);
    if (!Core.parseEpisodeUrl(url.href)) return null;
    // Preserve the selected player, without copying expiring navigation/tracking tokens.
    if (playerChoice(url.href) === null && preferredPlayer !== null) url.searchParams.set("pl", preferredPlayer);
    return url.href;
  }

  function nextEpisodeLink(context, roots = episodeRoots(), base = location.href, preferredPlayer = playerChoice(location.href)) {
    const links = [...new Set(roots.flatMap(root => [...root.querySelectorAll("a[href]")]))];
    const candidates = links.map(link => {
      let url;
      try { url = new URL(link.getAttribute("href"), base); } catch { return null; }
      const episode = Core.parseEpisodeUrl(url.href);
      if (!episode || episode.slug !== context.slug) return null;
      const explicit = (link.getAttribute("rel") || "").split(/\s+/).includes("next") || /next\s*episode/i.test(`${link.getAttribute("aria-label")} ${link.title} ${link.textContent}`);
      const sameSeason = episode.season === context.season && episode.episode === context.episode + 1;
      const nextSeason = episode.season === context.season + 1 && episode.episode === 1 && explicit;
      return sameSeason || nextSeason ? { element: link, url: episodePlaybackUrl(url.href, base, preferredPlayer), priority: Number(sameSeason) * 4 + Number(playerChoice(url.href) !== null) * 2 + Number(explicit) } : null;
    }).filter(Boolean).sort((a, b) => b.priority - a.priority);
    return candidates[0] || null;
  }

  function catalogUrl(value, context, base = location.href) {
    try {
      const url = new URL(value, base);
      const path = url.pathname.replace(/\/$/, "");
      if (!Core.isCalmUrl(url.href) || url.origin !== location.origin) return null;
      return path === `/shows/${context.slug}` || path === `/shows/${context.slug}/season-${context.season}` ? url.href : null;
    } catch { return null; }
  }

  function nextControl() {
    const context = state.response?.context;
    if (!isTop || !context || episodeIdentity() !== episodeIdentity({ context: Core.resolveEpisode(location.href, { [context.slug]: context.imdbId }) })) return null;
    const roots = episodeRoots();
    const direct = nextEpisodeLink(context, roots);
    if (direct) return direct;
    const controls = [...new Set(roots.flatMap(root => [...root.querySelectorAll('a[href],button,[role="button"]')]))];
    const button = controls.find(element => {
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const names = [element.getAttribute("aria-label"), element.title, element.textContent, element.getAttribute("data-testid"), element.getAttribute("data-action")];
      const explicitNext = names.some(name => /^(?:(?:play|watch|go\s+to)\s+)?next\s+episode(?:\s*[:\-–—]\s*.+|\s*[›»→▶])?$/i.test(String(name || "").trim().replace(/\s+/g, " ")) || /^(?:player[-_])?next[-_]episode(?:[-_]button)?$/i.test(String(name || "")));
      if (!explicitNext) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && ancestorsVisible(element);
    });
    if (button) return { element: button, url: null, catalog: catalogUrl(button.getAttribute("href") || button.getAttribute("data-href") || button.getAttribute("data-url"), context) };
    // Read a known season/show catalog when the player exposes no direct next link.
    const catalog = controls.map(element => catalogUrl(element.getAttribute("href"), context)).find(Boolean);
    return catalog ? { element: null, url: null, catalog } : null;
  }

  function clearNextContinuation() {
    try { sessionStorage.removeItem(NEXT_CONTINUATION_KEY); } catch { /* Storage can be disabled by site policy. */ }
  }

  function saveNextContinuation(context, automatic) {
    try {
      sessionStorage.setItem(NEXT_CONTINUATION_KEY, JSON.stringify({
        slug: context.slug, season: context.season, episode: context.episode,
        player: playerChoice(location.href), automatic, started: Date.now(),
      }));
    } catch { /* In-page chooser resolution still works without session storage. */ }
  }

  function waitForNextEpisode(context, preferredPlayer, isCurrent, timeout = 4000) {
    return new Promise(resolve => {
      let timer, queued, settled = false;
      const observer = new MutationObserver(records => {
        // A chooser can render in several batches; text-only playback updates do not trigger a scan.
        if (!records.some(record => record.type === "attributes" || [...record.addedNodes].some(node => node.nodeType === 1))) return;
        if (!queued) queued = setTimeout(() => { queued = null; inspect(); }, 50);
      });
      const finish = result => {
        if (settled) return;
        settled = true; observer.disconnect(); clearTimeout(timer); clearTimeout(queued); resolve(result);
      };
      const inspect = () => {
        if (settled) return;
        const actual = Core.parseEpisodeUrl(location.href);
        if (actual?.slug === context.slug && ((actual.season === context.season && actual.episode === context.episode + 1) || (actual.season === context.season + 1 && actual.episode === 1))) { finish({ arrived: true }); return; }
        if (!isCurrent()) { finish(null); return; }
        const next = nextEpisodeLink(context, episodeRoots(), location.href, preferredPlayer);
        if (next) finish(next);
      };
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
      timer = setTimeout(() => finish(null), timeout);
      inspect();
      // A site button can update only history; inspect once after its synchronous click.
      queueMicrotask(inspect);
    });
  }

  async function catalogNextEpisode(value, context, preferredPlayer) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      // Same-origin HTML only: the logged-in site resolves its own actual episode links.
      const response = await fetch(value, { credentials: "same-origin", signal: controller.signal, headers: { Accept: "text/html" } });
      if (!response.ok || !catalogUrl(response.url || value, context)) return null;
      const html = await response.text();
      if (html.length > 2000000) return null;
      return nextEpisodeLink(context, [new DOMParser().parseFromString(html, "text/html")], response.url || value, preferredPlayer);
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  async function openNextEpisode(request) {
    if (nextNavigation) return { ok: false, error: "The next episode is already opening." };
    const context = state.response?.context;
    const identity = episodeIdentity();
    const settingsAllow = () => !request.automatic || !state.response?.settings || (state.response.settings.enabled && state.response.settings.autoNext);
    const current = () => {
      const actual = Core.parseEpisodeUrl(location.href);
      return actual?.slug === context?.slug && actual.season === context.season && actual.episode === context.episode && episodeIdentity() === identity && settingsAllow();
    };
    const chooser = () => Boolean(catalogUrl(location.href, context)) && settingsAllow();
    if (!context || request.episodeKey !== identity || !current()) return { ok: false, error: "The episode or automatic-skip setting changed." };
    const control = nextControl();
    if (!control) return { ok: false, error: "No next-episode link or control was found. Playback will continue." };
    if (control.url) { setTimeout(() => { if (current()) location.assign(control.url); }, 0); return { ok: true }; }
    nextNavigation = {};
    try {
      const player = playerChoice(location.href);
      if (control.catalog) {
        const next = await catalogNextEpisode(control.catalog, context, player);
        if (!current()) return { ok: false, error: "The episode or automatic-skip setting changed." };
        if (next) { setTimeout(() => { if (current()) location.assign(next.url); }, 0); return { ok: true }; }
      }
      if (!control.element) return { ok: false, error: "The episode list did not contain the next episode. Playback will continue." };
      saveNextContinuation(context, Boolean(request.automatic));
      const waiting = waitForNextEpisode(context, player, () => current() || chooser());
      control.element.click();
      const next = await waiting;
      clearNextContinuation();
      if (next?.arrived) return { ok: true };
      if (next?.url && (current() || chooser())) {
        const latest = await message("GET_CONTEXT");
        const allowed = () => (current() || chooser()) && (!request.automatic || (latest?.ok && latest.settings?.enabled && latest.settings.autoNext));
        if (allowed()) { setTimeout(() => { if (allowed()) location.assign(next.url); }, 0); return { ok: true }; }
      }
      return { ok: false, error: "The episode chooser did not expose the next episode. Playback will continue." };
    } finally { nextNavigation = null; }
  }

  async function resumeNextEpisode() {
    if (!isTop) return;
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem(NEXT_CONTINUATION_KEY)); } catch { clearNextContinuation(); return; }
    if (!pending) return;
    clearNextContinuation();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pending.slug || "") || !Number.isSafeInteger(pending.season) || pending.season < 0 || !Number.isSafeInteger(pending.episode) || pending.episode < 1 || !Number.isFinite(pending.started) || Date.now() - pending.started < 0 || Date.now() - pending.started > 15000 || !catalogUrl(location.href, pending)) return;
    const player = /^(?:0|[1-9]\d?)$/.test(pending.player || "") ? pending.player : null;
    const response = await message("GET_CONTEXT");
    const enabled = () => !pending.automatic || Boolean(response?.ok && response.settings?.enabled && response.settings.autoNext);
    if (!enabled()) return;
    const catalog = location.href;
    const next = await waitForNextEpisode(pending, player, () => location.href === catalog && enabled());
    if (next?.url && location.href === catalog && enabled()) {
      const latest = await message("GET_CONTEXT");
      if (location.href === catalog && (!pending.automatic || (latest?.ok && latest.settings?.enabled && latest.settings.autoNext))) location.assign(next.url);
    }
  }

  async function advance(automatic = false) {
    state.countdown = null;
    const episode = episodeIdentity();
    // Native video fullscreen hides HTML controls, but must not disable auto-next.
    try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch { /* Navigation can still leave fullscreen when exit is unavailable. */ }
    if (episode !== episodeIdentity() || (automatic && (!state.response?.settings.enabled || !state.response.settings.autoNext || !mediaMatchesEpisode()))) return;
    const result = await message("NEXT_EPISODE", { episodeKey: episodeIdentity(), automatic });
    if (!result?.ok) {
      state.lastAction = result?.error || "No next-episode link was found.";
      state.toast = { text: state.lastAction, expires: Date.now() + 3000 };
    }
    render();
  }

  function beginNext(segment, automatic) {
    state.handled.add(segmentKey(segment));
    if (automatic) state.countdown = { end: Date.now() + 3000, episode: episodeIdentity(), start: segment.start, finish: segment.end, segment };
    else advance();
    render();
  }

  function frameCandidates() {
    const frames = [...document.querySelectorAll("iframe[src]")].map(frame => {
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      let frameIndex = -1;
      for (let i = 0; i < window.frames.length; i++) if (window.frames[i] === frame.contentWindow) { frameIndex = i; break; }
      return { url: frame.src, frameIndex, visible: rect.width >= 80 && rect.height >= 45 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && ancestorsVisible(frame), area: rect.width * rect.height };
    }).filter(frame => frame.visible).sort((a, b) => b.area - a.area);
    return frames;
  }

  async function playerStatus() {
    state.selectionDirty = true;
    selectVideo();
    if (isTop) state.players.set(0, { ...playback(), receivedAt: Date.now() });
    choosePlayer();
    let selected = state.players.get(state.activeFrameId);
    if (state.activeFrameId > 0) {
      const fresh = await message("PLAYER_COMMAND", { frameId: state.activeFrameId, command: "GET_PLAYER_STATUS" });
      if (fresh?.player) {
        selected = { ...fresh.player, hasVideo: fresh.player.videoFound, receivedAt: Date.now() };
        state.players.set(state.activeFrameId, selected);
      }
    }
    const origins = [];
    // Full discovery is performed by the popup. This fallback lists visible direct embed hosts.
    {
      const known = new Set();
      for (const frame of frameCandidates()) {
        try {
          const url = new URL(frame.url);
          if (url.protocol !== "https:" || Core.isCalmUrl(url.href) || known.has(url.origin)) continue;
          known.add(url.origin); origins.push({ origin: url.origin, granted: false });
        } catch { /* Ignore invalid frame URLs. */ }
      }
    }
    return { videoFound: Boolean(selected?.hasVideo), duration: selected?.duration ?? null, currentTime: selected?.currentTime || 0,
      safety: selected?.safety || { ok: false, reason: "Start playback or connect the embedded player." },
      canUndo: Boolean(selected?.canUndo), activeFrameId: state.activeFrameId, lastAction: selected?.lastAction || "",
      lastBlockReason: selected?.lastBlockReason || state.lastBlockReason, playerOrigins: origins };
  }

  function localPlayerStatus() {
    state.selectionDirty = true; selectVideo();
    const current = playback();
    return { ...current, videoFound: current.hasVideo, lastBlockReason: state.lastBlockReason };
  }

  function ensureOverlay() {
    if (state.overlay?.host.isConnected) return state.overlay;
    const host = document.createElement("div"); host.id = "thecalm-skip-overlay";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{position:fixed;z-index:2147483646;pointer-events:none;font:14px/1.45 system-ui,sans-serif;color:#eef8f7}*{box-sizing:border-box}section{max-width:min(380px,88vw);padding:12px 14px;border:1px solid #59827c;border-radius:12px;background:#122522f2;box-shadow:0 8px 30px #0006;pointer-events:auto}section[hidden]{display:none!important}section[data-kind="undo"],section[data-kind="toast"]{display:flex;align-items:center;gap:14px;padding:8px 12px}section[data-kind="undo"] p,section[data-kind="toast"] p{margin:0}section[data-kind="undo"] button{padding:4px 10px}p{margin:0 0 8px}button{font:inherit;color:#0a2421;background:#92e4cf;border:0;border-radius:7px;padding:7px 13px;cursor:pointer}button:focus-visible{outline:3px solid white;outline-offset:3px}button+button{margin-left:8px;background:transparent;color:#effbf8;border:1px solid #82a69e}.note{font-size:12px;color:#b7ccc6}`;
    const panel = document.createElement("section"); panel.setAttribute("aria-label", "CalmSkip"); panel.hidden = true;
    const text = document.createElement("p"); text.setAttribute("role", "status");
    const actions = document.createElement("div"); panel.append(text, actions); shadow.append(style, panel);
    (document.body || document.documentElement).append(host);
    state.overlay = { host, panel, text, actions };
    return state.overlay;
  }

  function button(label, action, id) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    if (id) node.id = id;
    node.addEventListener("click", action); return node;
  }

  function render() {
    if (!state.video || !state.response?.context) {
      if (state.overlay) state.overlay.panel.hidden = true;
      clearTimeout(state.uiTimer);
      return;
    }
    const segment = mediaMatchesEpisode() ? Core.segmentAt(state.response.timings, state.video.currentTime, state.response.settings) : null;
    const now = Date.now();
    let kind = "", text = "";
    if (state.countdown) { kind = "countdown"; text = `Next episode in ${Math.max(1, Math.ceil((state.countdown.end - now) / 1000))}…`; }
    else if (state.toast?.expires > now) { kind = state.undo ? "undo" : "toast"; text = state.toast.text; }
    else if (segment && !state.handled.has(segmentKey(segment)) && (!state.response.settings.enabled || !safety(segment).safe)) {
      kind = segment.type;
      text = `${segment.type === "outro" ? "Credits" : segment.type[0].toUpperCase() + segment.type.slice(1)} · ${Core.formatTime(segment.start)}–${Core.formatTime(segment.end)}`;
    }
    clearTimeout(state.uiTimer);
    if (!kind) { if (state.overlay) state.overlay.panel.hidden = true; return; }
    const overlay = ensureOverlay();
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.body;
    if (parent && overlay.host.parentNode !== parent) parent.append(overlay.host);
    const rect = state.video.getBoundingClientRect();
    const right = `${Math.max(12, window.innerWidth - rect.right + 16)}px`;
    const bottom = `${Math.max(12, window.innerHeight - rect.bottom + 54)}px`;
    if (overlay.host.style.right !== right) overlay.host.style.right = right;
    if (overlay.host.style.bottom !== bottom) overlay.host.style.bottom = bottom;
    overlay.panel.hidden = false;
    if (state.countdown) state.uiTimer = setTimeout(scheduleTick, Math.max(1, Math.min(1000, state.countdown.end - now)));
    else if (state.toast?.expires > now) state.uiTimer = setTimeout(render, state.toast.expires - now + 20);
    const renderKey = `${kind}:${text}`;
    if (overlay.panel.dataset.renderKey === renderKey) return;
    overlay.panel.dataset.renderKey = renderKey; overlay.panel.dataset.kind = kind; overlay.text.textContent = text; overlay.actions.replaceChildren();
    if (kind === "countdown") overlay.actions.append(button("Cancel", () => { state.countdown = null; state.toast = null; render(); }, "cancel-next"));
    else if (kind === "undo") overlay.actions.append(button("Undo", undo, "undo-skip"));
    else if (segment && ["intro", "recap", "outro"].includes(kind)) {
      overlay.actions.append(button(kind === "outro" ? "Next episode" : `Skip ${kind}`, () => kind === "outro" ? beginNext(segment, false) : skip(segment), "skip-segment"));
      overlay.actions.append(button("Keep watching", () => { state.handled.add(segmentKey(segment)); render(); }, "keep-watching"));
    }
  }

  function tick() {
    checkNavigation();
    if (!state.response?.context) { render(); return; }
    selectVideo();
    if (!state.video) {
      if (state.forceReport) { state.forceReport = false; report(true); }
      render(); return;
    }
    const force = state.forceReport; state.forceReport = false;
    report(force);
    const video = state.video;
    if (state.countdown) {
      if (state.countdown.episode !== episodeIdentity() || (video.paused && !video.ended) || video.seeking || !state.response.settings.enabled || !state.response.settings.autoNext || !safety(state.countdown.segment).safe || video.currentTime < state.countdown.start || (!video.ended && video.currentTime >= state.countdown.finish) || !geometry(video).visible) state.countdown = null;
      else if (Date.now() >= state.countdown.end) advance(true);
    }
    if (state.response.settings.enabled && !video.paused && !video.seeking) {
      const segment = Core.segmentAt(state.response.timings, video.currentTime, state.response.settings);
      if (segment && safety(segment).safe && !state.handled.has(segmentKey(segment))) {
        authorizeAndSkip(segment);
      }
    }
    render();
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (request.type === "CONTEXT_UPDATED") { state.actionPending = null; state.denial = null; state.countdown = null; refreshContext(); return false; }
    if (request.type === "GET_PLAYER_STATUS_DIRECT") { respond({ player: localPlayerStatus() }); return false; }
    if (request.type === "GET_PLAYER_STATUS" && isTop) { playerStatus().then(player => respond({ player })); return true; }
    if (request.type === "GET_FRAME_CANDIDATES" && isTop) { respond({ candidates: frameCandidates() }); return false; }
    if (request.type === "PLAYER_STATUS" && isTop) {
      const playback = request.playback;
      if (playback?.episodeKey === episodeIdentity()) state.players.set(request.frameId, { ...playback, receivedAt: Date.now() });
      respond({ activeFrameId: choosePlayer(), frameId: request.frameId, isActive: state.activeFrameId === request.frameId });
      return false;
    }
    if (request.type === "UNDO_SKIP_DIRECT") { respond(undo()); return false; }
    if (request.type === "UNDO_SKIP" && isTop) {
      choosePlayer();
      if (state.activeFrameId === 0) { respond(undo()); return false; }
      message("PLAYER_COMMAND", { frameId: state.activeFrameId, command: "UNDO_SKIP" }).then(respond); return true;
    }
    if (request.type === "NEXT_EPISODE" && isTop) {
      openNextEpisode(request).then(respond, () => respond({ ok: false, error: "The next episode could not be opened. Playback will continue." }));
      return true;
    }
    return false;
  });

  if (isTop) resumeNextEpisode();

  document.addEventListener("fullscreenchange", () => { state.selectionDirty = true; scheduleTick(); });
  window.addEventListener("online", () => {
    if (!state.contextFailed) return;
    clearTimeout(state.contextRetryTimer); state.contextRetryTimer = null; state.contextRetryAttempt = 0; refreshContext();
  });
  window.addEventListener("resize", () => { if (state.discoveryActive) { state.selectionDirty = true; scheduleTick(); } });
  if (isTop) { state.url = "__initial__"; checkNavigation(); }
  else refreshContext();
  if (isTop) {
    window.addEventListener("popstate", checkNavigation);
    setInterval(checkNavigation, 1000);
  }
})();
