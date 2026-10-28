/* Optional host access is granted by the popup for an actual, visible player frame. */
(() => {
  "use strict";
  const ownOrigin = (value) => {
    try { const url = new URL(value); return url.protocol === "https:" ? url.origin : null; }
    catch { return null; }
  };
  const frameUrl = (value) => {
    try { const url = new URL(value); url.hash = ""; return url.href; } catch { return null; }
  };
  const visibilityCache = new Map();
  const associationCache = new Map();
  const knownTabs = new Map();
  const injections = new Map();
  const navigationQueues = new Map();
  const topCompletions = new Map();
  const fingerprints = new Map();
  const sessionKey = tabId => `calmPlayerRoots:${tabId}`;

  async function fingerprint(url) {
    const canonical = frameUrl(url);
    if (!canonical) return null;
    if (!fingerprints.has(canonical)) {
      if (fingerprints.size >= 128) fingerprints.delete(fingerprints.keys().next().value);
      fingerprints.set(canonical, crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)).then(digest =>
        [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")));
    }
    return fingerprints.get(canonical);
  }

  async function associations(tabId, tab, frames) {
    const owner = frames.find(frame => frame.frameId === 0)?.documentId || JSON.stringify(CalmSkip.parseEpisodeUrl(tab.url));
    let cached = associationCache.get(tabId);
    if (!cached || cached.owner !== owner) {
      cached = { owner, promise: (async () => {
        let stored;
        try { stored = (await chrome.storage.session?.get(sessionKey(tabId)))?.[sessionKey(tabId)]; } catch { /* Session persistence is optional. */ }
        const roots = stored?.owner === owner && stored.roots && typeof stored.roots === "object" ? { ...stored.roots } : {};
        return { owner, roots };
      })() };
      associationCache.set(tabId, cached);
    }
    return cached.promise;
  }

  async function discover(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!CalmSkip.parseEpisodeUrl(tab.url)) throw new Error("Open an episode on TheCalm first.");
    const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
    let candidates = [];
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "GET_FRAME_CANDIDATES" }, { frameId: 0 });
      candidates = result?.candidates || [];
    } catch { /* Reloading the page installs its top-level content script. */ }
    const roots = new Set((await Promise.all(candidates.filter(item => item.visible).map(item => fingerprint(item.url)))).filter(Boolean));
    const associated = await associations(tabId, tab, frames);
    const presentIds = new Set(frames.map(frame => String(frame.frameId)));
    let changed = false;
    for (const id of Object.keys(associated.roots)) {
      if (!presentIds.has(id)) { delete associated.roots[id]; changed = true; }
    }
    const direct = new Set();
    for (const frame of frames.filter(frame => frame.frameId > 0 && frame.parentFrameId === 0)) {
      const source = await fingerprint(frame.url);
      if (roots.has(source) && associated.roots[frame.frameId] !== source) {
        associated.roots[frame.frameId] = source; changed = true;
      }
      // A connected frame may change its own URL. Its verified DOM parent
      // still identifies it; current-origin permissions are checked separately.
      if (roots.has(associated.roots[frame.frameId])) direct.add(frame.frameId);
    }
    if (changed) {
      try { await chrome.storage.session?.set({ [sessionKey(tabId)]: associated }); } catch { /* Keep the in-memory association if storage is unavailable. */ }
    }
    const selected = new Set(direct);
    const children = new Map();
    for (const frame of frames) {
      if (!children.has(frame.parentFrameId)) children.set(frame.parentFrameId, []);
      children.get(frame.parentFrameId).push(frame.frameId);
    }
    // Walk the visible embed's descendants once, instead of scanning all frames N times.
    const queue = [...direct];
    for (let i = 0; i < queue.length; i++) {
      for (const id of children.get(queue[i]) || []) {
        if (!selected.has(id)) { selected.add(id); queue.push(id); }
      }
    }
    const origins = [...new Set(frames.filter(frame => selected.has(frame.frameId)).map(frame => ownOrigin(frame.url)).filter(origin => origin && !["https://thecalm.site", "https://www.thecalm.site"].includes(origin)))];
    const playerOrigins = await Promise.all(origins.map(async origin => ({ origin, granted: await chrome.permissions.contains({ origins: [`${origin}/*`] }) })));
    return { frames: frames.filter(frame => selected.has(frame.frameId)), playerOrigins };
  }

  function discovery(tabId, refresh = false) {
    let cached = visibilityCache.get(tabId);
    if (refresh && cached?.pending) {
      // Interactive discovery must not inherit a snapshot started before a
      // newly inserted embed existed. Let the old scan finish, then refresh.
      return cached.promise.then(() => discovery(tabId, true), () => discovery(tabId, true));
    }
    if (!cached || (!cached.pending && (refresh || Date.now() - cached.time > 500))) {
      cached = { time: Date.now(), pending: true };
      cached.promise = discover(tabId).finally(() => { cached.pending = false; });
      visibilityCache.set(tabId, cached);
    }
    return cached.promise;
  }

  async function injectFrame(tabId, frame) {
    const key = `${tabId}:${frame.frameId}`;
    const documentKey = frame.documentId || frameUrl(frame.url);
    const existing = injections.get(key);
    if (existing?.documentKey === documentKey) return existing.promise;
    const record = { documentKey };
    record.promise = (async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ["shared.js", "content.js"] });
        return true;
      } catch {
        if (injections.get(key) === record) injections.delete(key);
        return false;
      }
    })();
    injections.set(key, record);
    return record.promise;
  }

  async function connect(tabId, requested) {
    const discovered = await discovery(tabId, Boolean(requested));
    const actual = new Set(discovered.playerOrigins.map(item => item.origin));
    const origins = requested || discovered.playerOrigins.filter(item => item.granted).map(item => item.origin);
    if (!Array.isArray(origins) || origins.some(origin => !actual.has(origin))) throw new Error("The embedded player changed. Reopen the popup and choose its current host.");
    const permitted = new Set();
    for (const origin of origins) {
      if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) permitted.add(origin);
      else if (requested) throw new Error("Grant access to this player from the extension popup first.");
    }
    let count = 0;
    for (const frame of discovered.frames) {
      if (!permitted.has(ownOrigin(frame.url))) continue;
      if (await injectFrame(tabId, frame)) count++;
    }
    if (requested && !count) throw new Error("No accessible player was found. Start playback, then try connecting its host again.");
    return { ok: true, connectedFrames: count, playerOrigins: discovered.playerOrigins };
  }

  function reconnect(tabId, frameId) {
    let queued = navigationQueues.get(tabId);
    if (queued) {
      if (frameId === null) queued.all = true;
      else queued.frameIds.add(frameId);
      return queued.promise;
    }
    queued = { all: frameId === null, frameIds: new Set(frameId === null ? [] : [frameId]) };
    queued.promise = Promise.resolve().then(async () => {
      while (knownTabs.has(tabId) && (queued.all || queued.frameIds.size)) {
        const all = queued.all;
        const frameIds = new Set(queued.frameIds);
        queued.all = false; queued.frameIds.clear();
        try {
          const found = await discovery(tabId, true);
          const granted = new Set(found.playerOrigins.filter(item => item.granted).map(item => item.origin));
          for (const frame of found.frames) {
            if ((all || frameIds.has(frame.frameId)) && granted.has(ownOrigin(frame.url))) await injectFrame(tabId, frame);
          }
        } catch { /* A closing tab or loading player can be retried on its next navigation. */ }
      }
    }).finally(() => { if (navigationQueues.get(tabId) === queued) navigationQueues.delete(tabId); });
    navigationQueues.set(tabId, queued);
    return queued.promise;
  }

  function forget(tabId) {
    knownTabs.delete(tabId); visibilityCache.delete(tabId); associationCache.delete(tabId); topCompletions.delete(tabId);
    for (const key of injections.keys()) if (key.startsWith(`${tabId}:`)) injections.delete(key);
  }

  function trackTab(tab) {
    if (!Number.isInteger(tab?.id)) return;
    const episode = CalmSkip.parseEpisodeUrl(tab.url);
    if (!episode) { forget(tab.id); return; }
    const key = JSON.stringify(episode);
    if (knownTabs.get(tab.id) === key) return;
    knownTabs.set(tab.id, key);
    // Do not block a context/timestamp lookup on frame discovery or injection.
    reconnect(tab.id, null);
  }

  globalThis.CalmPlayers = {
    trackTab,
    async isVisibleFrame(tabId, frameId) {
      try { return (await discovery(tabId)).frames.some(frame => frame.frameId === frameId); }
      catch { return false; }
    },
    async handleMessage(message) {
      if (!Number.isInteger(message.tabId)) return { ok: false, error: "No TheCalm tab was selected." };
      if (message.type === "PLAYER_ORIGINS") return { ok: true, playerOrigins: (await discovery(message.tabId, true)).playerOrigins };
      return connect(message.tabId, message.origins);
    }
  };

  // Unrelated pages are discarded without any tab/frame queries. In known
  // episode tabs, a completed child document reconnects only that document.
  chrome.webNavigation.onCompleted.addListener(({ tabId, frameId, url, documentId }) => {
    if (frameId === 0) {
      if (!CalmSkip.parseEpisodeUrl(url)) { forget(tabId); return; }
      trackTab({ id: tabId, url });
      const completedKey = documentId || frameUrl(url);
      if (topCompletions.get(tabId) === completedKey) return;
      topCompletions.set(tabId, completedKey);
      return reconnect(tabId, null);
    }
    if (!knownTabs.has(tabId)) return;
    const origin = ownOrigin(url);
    if (!origin || CalmSkip.isCalmUrl(url)) return;
    // Ads and other ungranted frames do not trigger a full player discovery.
    return chrome.permissions.contains({ origins: [`${origin}/*`] }).then(granted => {
      if (granted && knownTabs.has(tabId)) return reconnect(tabId, frameId);
    }).catch(() => {});
  }, { url: [{ schemes: ["https"] }] });
  chrome.tabs.onRemoved.addListener(tabId => {
    forget(tabId);
    try { chrome.storage.session?.remove(sessionKey(tabId))?.catch(() => {}); } catch { /* A closed session needs no cleanup. */ }
  });
})();
