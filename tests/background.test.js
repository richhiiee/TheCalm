const test = require("node:test");
const assert = require("node:assert/strict");
const { createBackgroundRuntime, CACHE_TTL, MISSING_TTL, SETTINGS_SCHEMA_VERSION } = require("../extension/background.js");

const EPISODE_URL = "https://thecalm.site/shows/prison-break/season-1/episode-18";
const context = { slug: "prison-break", imdbId: "tt0455275", season: 1, episode: 18 };
const raw = () => ({ imdb_id: "tt0455275", media_type: "tv", is_movie: false, season: 1, episode: 18, intro: { start_sec: 269, end_sec: 302, confidence: 1, submission_count: 1 }, recap: { start_sec: 0, end_sec: 52, confidence: 1, submission_count: 1 }, outro: { start_sec: 2599, end_sec: 2639, confidence: 1, submission_count: 1 } });

function setup(fetchImpl, options = {}) {
  const data = structuredClone(options.initialData || {});
  const sent = [];
  const access = { granted: true };
  const tabs = new Map([[7, { id: 7, url: EPISODE_URL }], [8, { id: 8, url: "https://unrelated.test/" }]]);
  const chrome = {
    runtime: { id: "test-extension", getURL: path => `chrome-extension://test-extension/${path}` },
    permissions: { async contains() { return access.granted; } },
    storage: { local: {
      async get(keys) {
        const list = typeof keys === "string" ? [keys] : keys;
        return structuredClone(Object.fromEntries(list.map(key => [key, data[key]])));
      },
      async set(value) { Object.assign(data, structuredClone(value)); },
    } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error("Tab closed"); return tabs.get(id); },
      async query() { return [...tabs.values()].filter(tab => tab.url.startsWith("https://thecalm.site/")); },
      async sendMessage(tabId, message, target) { sent.push({ tabId, message, target }); return { ok: true, activeFrameId: 0 }; },
    },
  };
  const runtime = createBackgroundRuntime(chrome, fetchImpl, options);
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
  const top = { id: chrome.runtime.id, tab: { id: 7, url: EPISODE_URL }, frameId: 0, url: EPISODE_URL };
  const frame = { ...top, frameId: 4, url: "https://player.example/embed" };
  return { runtime, data, sent, popup, top, frame, tabs, access, chrome };
}

test("fetches the exact public episode, coalesces concurrent lookups, and caches success", async () => {
  let calls = 0;
  let release;
  const h = setup(async (url, options) => {
    calls++;
    assert.equal(url, "https://api.introdb.app/segments?imdb_id=tt0455275&season=1&episode=18");
    assert.equal(options.credentials, "omit");
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(raw()));
  });
  const first = h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  const second = h.runtime.dispatch({ type: "GET_CONTEXT" }, h.frame);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, "ready");
    assert.equal(result.timings.segments.recap.start, 0);
    assert.equal(result.settings.enabled, true);
  }
  assert.equal((await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup)).status, "ready");
  assert.equal(calls, 1);
  assert.ok(h.data.timingCache["tt0455275:1:18"].expiresAt - Date.now() <= CACHE_TTL);
});

test("new installs enable automatic skipping and initialize the settings schema", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  const state = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(state.settings.enabled, true);
  assert.equal(h.data.settings.enabled, true);
  assert.equal(h.data.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
});

test("a slow context lookup follows the current episode instead of returning stale timings", async () => {
  let release;
  const requested = [];
  const h = setup(async url => {
    const episode = Number(new URL(url).searchParams.get("episode"));
    requested.push(episode);
    if (episode === 18) await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ ...raw(), episode, recap: { start_sec: 0, end_sec: episode === 19 ? 60 : 52, confidence: 1 } }));
  });
  const pending = h.runtime.dispatch({ type: "GET_CONTEXT" }, h.frame);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.tabs.set(7, { id: 7, url: EPISODE_URL.replace("episode-18", "episode-19") });
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.context.episode, 19);
  assert.equal(result.timings.episode, 19);
  assert.equal(result.timings.segments.recap.end, 60);
  assert.deepEqual(requested, [18, 19]);
});

test("context lookups discard delayed data after leaving the episode and bound repeated transitions", async () => {
  let release;
  const left = setup(async () => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(raw()));
  });
  const pending = left.runtime.dispatch({ type: "GET_CONTEXT" }, left.frame);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  left.tabs.set(7, { id: 7, url: "https://thecalm.site/shows/prison-break" });
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.timings, undefined);

  let calls = 0;
  const changing = setup(async url => {
    calls++;
    const episode = Number(new URL(url).searchParams.get("episode"));
    changing.tabs.set(7, { id: 7, url: EPISODE_URL.replace("episode-18", `episode-${episode + 1}`) });
    return new Response(JSON.stringify({ ...raw(), episode }));
  });
  const unstable = await changing.runtime.dispatch({ type: "GET_CONTEXT" }, changing.frame);
  assert.equal(unstable.ok, false);
  assert.equal(unstable.retryable, true);
  assert.equal(calls, 3, "an unstable route must not keep the worker in an unbounded lookup loop");
});

test("old review mode upgrades once while later explicit pause survives worker restarts", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())), { initialData: {
    settings: { enabled: false, skipIntro: false, skipRecap: true, autoNext: false },
  } });
  const upgraded = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.deepEqual(upgraded.settings, { enabled: true, skipIntro: false, skipRecap: true, autoNext: false });
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: false } }, h.popup);
  const restarted = createBackgroundRuntime(h.chrome, async () => { throw new Error("valid cached timings should be reused"); });
  const paused = await restarted.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(paused.settings.enabled, false, "explicit pause must not be re-enabled on worker restart");
  await restarted.dispatch({ type: "SET_SETTINGS", settings: { skipIntro: true } }, h.popup);
  assert.equal((await restarted.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup)).settings.enabled, false);
});

test("an already migrated paused installation remains paused", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())), { initialData: {
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    settings: { enabled: false, skipIntro: true, skipRecap: true, autoNext: true },
  } });
  assert.equal((await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup)).settings.enabled, false);
});

test("unreachable provider is an error, is not cached, and can recover", async () => {
  let calls = 0;
  const h = setup(async () => { if (++calls === 1) throw new TypeError("Failed to fetch"); return new Response(JSON.stringify(raw())); });
  const failed = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(failed.status, "error");
  assert.equal(failed.timings, null);
  assert.equal(h.data.timingCache, undefined);
  assert.equal((await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup)).status, "ready");
  assert.equal(calls, 2);
});

test("404 means missing data, distinct from authorization/rate-limit failure", async () => {
  let clock = 1000;
  let calls = 0;
  const h = setup(async () => { calls++; return new Response("", { status: 404 }); }, { now: () => clock });
  assert.equal((await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup)).status, "missing");
  clock += MISSING_TTL - 1;
  await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(calls, 1);
  clock += 2;
  await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(calls, 2);
  const denied = setup(async () => new Response("not authorized", { status: 403 }));
  const result = await denied.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, denied.popup);
  assert.equal(result.status, "error");
  assert.match(result.error, /HTTP 403/);
  assert.equal(denied.data.timingCache, undefined);
});

test("wrong episode and corrupt provider JSON are rejected without storing data", async () => {
  for (const body of [JSON.stringify({ ...raw(), episode: 19 }), "<html>error</html>"]) {
    const h = setup(async () => new Response(body));
    const result = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
    assert.equal(result.status, "error");
    assert.equal(result.timings, null);
    assert.equal(h.data.timingCache, undefined);
  }
});

test("contradictory absent flags stay rejected across repeated fetches and imports", async () => {
  let calls = 0;
  const contradictory = { ...raw(), no_intro: true };
  const h = setup(async () => { calls++; return new Response(JSON.stringify(contradictory)); });
  for (let i = 0; i < 2; i++) {
    const fetched = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
    assert.equal(fetched.status, "error");
    assert.match(fetched.error, /marks intro absent/);
    const imported = await h.runtime.dispatch({ type: "IMPORT_TIMINGS", tabId: 7, data: contradictory }, h.popup);
    assert.equal(imported.ok, false);
    assert.equal(h.data.timingCache, undefined, "unsafe state must not become safe after cache projection");
  }
  assert.equal(calls, 2);
});

test("episode changes broadcast before a pending provider response, without same-context loops", async () => {
  let release;
  const h = setup(async () => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify(raw()));
  });
  const first = h.runtime.dispatch({ type: "SET_EPISODE", url: EPISODE_URL }, h.top);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.filter(entry => entry.message.type === "CONTEXT_UPDATED").length, 1);
  const repeated = h.runtime.dispatch({ type: "SET_EPISODE", url: EPISODE_URL }, h.top);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.filter(entry => entry.message.type === "CONTEXT_UPDATED").length, 1);
  release();
  await Promise.all([first, repeated]);
});

test("popup import immediately overrides pending network fetch and strips unrelated provider fields", async () => {
  let release;
  const h = setup(async () => {
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ ...raw(), intro: { start_sec: 270, end_sec: 303, confidence: 1 } }));
  });
  const pending = h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const imported = await h.runtime.dispatch({ type: "IMPORT_TIMINGS", tabId: 7, data: { ...raw(), unrelated: "not retained" } }, h.popup);
  assert.equal(imported.source, "IntroDB import");
  assert.equal(imported.timings.segments.intro.start, 269);
  release();
  const oldLookup = await pending;
  assert.equal(oldLookup.source, "IntroDB import");
  assert.equal(oldLookup.timings.segments.intro.start, 269);
  assert.equal(h.data.timingCache["tt0455275:1:18"].raw.unrelated, undefined);
  assert.ok(h.sent.some(entry => entry.message.type === "CONTEXT_UPDATED"));
});

test("content and unrelated pages cannot change settings/import data or forge another episode", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  const altered = await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: true } }, h.frame);
  assert.equal(altered.ok, false);
  assert.equal(h.data.settings, undefined);
  const imported = await h.runtime.dispatch({ type: "IMPORT_TIMINGS", data: raw() }, h.top);
  assert.equal(imported.ok, false);
  const outside = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 8 }, h.popup);
  assert.equal(outside.ok, false);
  const fakeTop = await h.runtime.dispatch({ type: "SET_EPISODE", url: EPISODE_URL.replace("episode-18", "episode-19") }, h.top);
  assert.equal(fakeTop.ok, false);
  const embedded = await h.runtime.dispatch({ type: "SET_EPISODE", url: EPISODE_URL }, h.frame);
  assert.equal(embedded.ok, false);
  const otherExtension = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, { ...h.popup, id: "other" });
  assert.equal(otherExtension.ok, false);
});

test("settings are sanitized and broadcast; content status/next/undo are routed to top frame", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  const changed = await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: true, skipIntro: false, notASetting: true } }, h.popup);
  assert.deepEqual(changed.settings, { enabled: true, skipIntro: false, skipRecap: true, autoNext: true });
  assert.equal(h.data.settings.notASetting, undefined);
  await h.runtime.dispatch({ type: "REPORT_STATUS", playback: { hasVideo: true, duration: 2639, episodeKey: "prison-break:1:18:tt0455275" } }, h.frame);
  const status = h.sent.find(entry => entry.message.type === "PLAYER_STATUS");
  assert.equal(status.message.frameId, 4);
  assert.deepEqual(status.target, { frameId: 0 });
  await h.runtime.dispatch({ type: "NEXT_EPISODE", episodeKey: "prison-break:1:18:tt0455275" }, h.frame);
  await h.runtime.dispatch({ type: "UNDO_SKIP", tabId: 7 }, h.popup);
  await h.runtime.dispatch({ type: "PLAYER_COMMAND", frameId: 4, command: "UNDO_SKIP" }, h.top);
  assert.ok(h.sent.some(entry => entry.message.type === "NEXT_EPISODE" && entry.target.frameId === 0));
  assert.ok(h.sent.some(entry => entry.message.type === "UNDO_SKIP_DIRECT" && entry.target.frameId === 4));
});

test("stale embedded frames cannot report or advance after SPA episode navigation", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  h.tabs.get(7).url = EPISODE_URL.replace("episode-18", "episode-19");
  const report = await h.runtime.dispatch({ type: "REPORT_STATUS", playback: { hasVideo: true, duration: 2639, episodeKey: "prison-break:1:18:tt0455275" } }, h.frame);
  assert.equal(report.isActive, false);
  assert.equal(report.activeFrameId, null);
  const advance = await h.runtime.dispatch({ type: "NEXT_EPISODE", episodeKey: "prison-break:1:18:tt0455275" }, h.frame);
  assert.equal(advance.ok, false);
  assert.equal(h.sent.length, 0);
});

test("a player remains inactive when the top-page arbitration script cannot respond", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  // The mock records the attempted relay and then simulates a disconnected content script.
  h.sent.push = () => { throw new Error("Receiving end does not exist"); };
  const result = await h.runtime.dispatch({ type: "REPORT_STATUS", playback: { hasVideo: true, duration: 2639, episodeKey: "prison-break:1:18:tt0455275" } }, h.frame);
  assert.equal(result.activeFrameId, null);
  assert.equal(result.isActive, false);
});

test("revoking a cross-origin player grant denies active reports and next navigation", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  h.access.granted = false;
  const report = await h.runtime.dispatch({ type: "REPORT_STATUS", playback: { hasVideo: true, episodeKey: "prison-break:1:18:tt0455275" } }, h.frame);
  assert.equal(report.isActive, false);
  assert.equal(report.activeFrameId, null);
  const next = await h.runtime.dispatch({ type: "NEXT_EPISODE", episodeKey: "prison-break:1:18:tt0455275" }, h.frame);
  assert.equal(next.ok, false);
  assert.match(next.error, /no longer granted/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.type, "PLAYER_STATUS");
  assert.equal(h.sent[0].message.playback.hasVideo, false);
  assert.equal(h.sent[0].message.playback.visible, false);
});

test("hidden parent frame is denied active status even when its internal video reports visible", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())), { players: { async isVisibleFrame(tabId, frameId) {
    assert.equal(tabId, 7); assert.equal(frameId, 4); return false;
  } } });
  const report = await h.runtime.dispatch({ type: "REPORT_STATUS", playback: { hasVideo: true, visible: true, episodeKey: "prison-break:1:18:tt0455275" } }, h.frame);
  assert.equal(report.isActive, false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.playback.hasVideo, false);
  assert.equal(h.sent[0].message.playback.visible, false);
  const next = await h.runtime.dispatch({ type: "NEXT_EPISODE", automatic: false, episodeKey: "prison-break:1:18:tt0455275" }, h.frame);
  assert.equal(next.ok, false);
  assert.match(next.error, /no longer visible/);
  assert.equal(h.sent.length, 1, "a hidden frame must never forward next-episode navigation");
});

test("disabling automatic advance is checked immediately by worker without blocking manual review", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  const next = { type: "NEXT_EPISODE", automatic: true, episodeKey: "prison-break:1:18:tt0455275" };
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: false } }, h.popup);
  assert.equal((await h.runtime.dispatch(next, h.frame)).ok, false, "explicit pause must not automatically advance");
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: true, autoNext: true } }, h.popup);
  assert.equal((await h.runtime.dispatch(next, h.frame)).ok, true);
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { autoNext: false } }, h.popup);
  assert.equal((await h.runtime.dispatch(next, h.frame)).ok, false);
  assert.equal((await h.runtime.dispatch({ ...next, automatic: false }, h.frame)).ok, true);
});

test("cache expires and explicit refresh refetches even when an entry is fresh", async () => {
  let clock = 1000;
  let calls = 0;
  const h = setup(async () => { calls++; return new Response(JSON.stringify(raw())); }, { now: () => clock });
  await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  await h.runtime.dispatch({ type: "REFRESH_TIMINGS", tabId: 7 }, h.popup);
  assert.equal(calls, 2);
  clock += CACHE_TTL + 1;
  await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(calls, 3);
});

test("request timeout reports an error and does not write a missing-data cache", async () => {
  const h = setup((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { timeoutMs: 5 });
  const result = await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  assert.equal(result.status, "error");
  assert.match(result.error, /respond in time/);
  assert.equal(h.data.timingCache, undefined);
});

const authorizeIntro = (extra = {}) => ({
  type: "AUTHORIZE_SKIP", episodeKey: "prison-break:1:18:tt0455275",
  segmentType: "intro", currentTime: 270, duration: 2639, ...extra,
});

test("a cached skip is authorized without a heartbeat or top-page arbitration", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return new Response(JSON.stringify(raw())); });
  await h.runtime.dispatch({ type: "GET_CONTEXT", tabId: 7 }, h.popup);
  h.sent.length = 0;
  h.sent.push = () => { throw new Error("The top page did not answer playback status."); };
  const authorized = await h.runtime.dispatch(authorizeIntro(), h.frame);
  assert.equal(authorized.ok, true);
  assert.equal(authorized.authorized, true);
  assert.deepEqual(authorized.segment, { type: "intro", start: 269, end: 302, confidence: 1, submissionCount: 1 });
  assert.equal(authorized.episodeKey, "prison-break:1:18:tt0455275");
  assert.equal(calls, 1, "authorization should reuse the already fetched episode");
  assert.equal(h.sent.length, 0, "authorization must not renew a heartbeat lease");
});

test("on-action authorization can fetch missing cache once and reuse it", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return new Response(JSON.stringify(raw())); });
  assert.equal((await h.runtime.dispatch(authorizeIntro(), h.top)).authorized, true);
  assert.equal((await h.runtime.dispatch(authorizeIntro({ currentTime: 280 }), h.top)).authorized, true);
  assert.equal(calls, 1);
});

test("authorization rejects invalid segments, stale episode, popup calls, and invalid playback bounds", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return new Response(JSON.stringify(raw())); });
  for (const request of [
    authorizeIntro({ episodeKey: "prison-break:1:19:tt0455275" }),
    authorizeIntro({ segmentType: "__proto__" }),
    authorizeIntro({ segmentType: "unknown" }),
    authorizeIntro({ currentTime: NaN }),
    authorizeIntro({ duration: Infinity }),
    authorizeIntro({ duration: 0 }),
  ]) {
    const result = await h.runtime.dispatch(request, h.frame);
    assert.equal(result.ok, true);
    assert.equal(result.authorized, false, JSON.stringify(request));
  }
  const popup = await h.runtime.dispatch({ ...authorizeIntro(), tabId: 7 }, h.popup);
  assert.equal(popup.authorized, false);
  assert.equal(calls, 0, "invalid requests must not start a provider lookup");
  assert.equal((await h.runtime.dispatch(authorizeIntro({ currentTime: 52 }), h.frame)).authorized, false);
  assert.equal((await h.runtime.dispatch(authorizeIntro({ currentTime: 302 }), h.frame)).authorized, false);
  assert.equal((await h.runtime.dispatch(authorizeIntro({ duration: 290 }), h.frame)).authorized, false);
});

test("authorization checks current pause and per-type settings before fetching", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return new Response(JSON.stringify(raw())); });
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: false } }, h.popup);
  let result = await h.runtime.dispatch(authorizeIntro(), h.frame);
  assert.equal(result.authorized, false);
  assert.match(result.reason, /paused/);
  await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: true, skipIntro: false } }, h.popup);
  result = await h.runtime.dispatch(authorizeIntro(), h.frame);
  assert.equal(result.authorized, false);
  assert.equal(calls, 0);
  assert.equal((await h.runtime.dispatch(authorizeIntro({ segmentType: "recap", currentTime: 2 }), h.frame)).authorized, true);
});

test("authorization denies revoked hosts, hidden parents, and unavailable or low-confidence data", async () => {
  let calls = 0;
  const revoked = setup(async () => { calls++; return new Response(JSON.stringify(raw())); });
  revoked.access.granted = false;
  const denied = await revoked.runtime.dispatch(authorizeIntro(), revoked.frame);
  assert.equal(denied.authorized, false);
  assert.match(denied.reason, /no longer granted/);
  assert.equal(calls, 0);

  const hidden = setup(async () => new Response(JSON.stringify(raw())), { players: { async isVisibleFrame() { return false; } } });
  const invisible = await hidden.runtime.dispatch(authorizeIntro(), hidden.frame);
  assert.equal(invisible.authorized, false);
  assert.match(invisible.reason, /no longer visible/);

  for (const [fetcher, expected] of [
    [async () => new Response("", { status: 404 }), /No skip timings/],
    [async () => { throw new TypeError("offline"); }, /Could not reach/],
    [async () => new Response(JSON.stringify({ ...raw(), intro: { start_sec: 269, end_sec: 302, confidence: 0.2 } })), /confidence/],
  ]) {
    const h = setup(fetcher);
    const result = await h.runtime.dispatch(authorizeIntro(), h.frame);
    assert.equal(result.ok, true);
    assert.equal(result.authorized, false);
    assert.match(result.reason, expected);
  }
});

test("a slow authorization lookup rechecks navigation and pause before replying", async () => {
  for (const change of ["navigate", "pause"]) {
    let release;
    const h = setup(async () => {
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify(raw()));
    });
    const pending = h.runtime.dispatch(authorizeIntro(), h.frame);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    if (change === "navigate") h.tabs.get(7).url = EPISODE_URL.replace("episode-18", "episode-19");
    else await h.runtime.dispatch({ type: "SET_SETTINGS", settings: { enabled: false } }, h.popup);
    release();
    const result = await pending;
    assert.equal(result.authorized, false, change);
    assert.match(result.reason, change === "navigate" ? /episode changed/ : /paused/);
  }
});

test("only the main page may request fresh child-player status", async () => {
  const h = setup(async () => new Response(JSON.stringify(raw())));
  const command = { type: "PLAYER_COMMAND", command: "GET_PLAYER_STATUS", frameId: 4 };
  assert.equal((await h.runtime.dispatch(command, h.top)).ok, true);
  assert.deepEqual(h.sent, [{ tabId: 7, message: { type: "GET_PLAYER_STATUS_DIRECT" }, target: { frameId: 4 } }]);
  assert.equal((await h.runtime.dispatch(command, h.frame)).ok, false);
  assert.equal((await h.runtime.dispatch({ ...command, tabId: 7 }, h.popup)).ok, false);
  assert.equal((await h.runtime.dispatch({ ...command, command: "__proto__" }, h.top)).ok, false);
  assert.equal(h.sent.length, 1, "untrusted callers must not relay commands to another frame");
});

test("only the current main episode page can request an event-driven player reconnect", async () => {
  const connected = [];
  const h = setup(async () => { throw new Error("player reconnect must not fetch timings"); }, { players: {
    trackTab() {}, async reconnectTab(tabId) { connected.push(tabId); },
  } });
  const request = { type: "PLAYER_FRAMES_CHANGED" };
  assert.equal((await h.runtime.dispatch(request, h.top)).ok, true);
  assert.deepEqual(connected, [7]);
  assert.equal((await h.runtime.dispatch(request, h.frame)).ok, false);
  assert.equal((await h.runtime.dispatch({ ...request, tabId: 7 }, h.popup)).ok, false);
  h.tabs.set(7, { id: 7, url: "https://thecalm.site/shows/prison-break" });
  assert.equal((await h.runtime.dispatch(request, h.top)).ok, false);
  assert.deepEqual(connected, [7]);
});

const bcsSearch = require('./fixtures/introdb-search-better-call-saul.json');
const simpsonsSearch = require('./fixtures/introdb-search-the-simpsons.json');
const ghostsSearch = require('./fixtures/introdb-search-ghosts.json');
const bcsSegments = require('./fixtures/better-call-saul-s01e01.json');
const simpsonsSegments = require('./fixtures/simpsons-s13e03.json');
const seriesUrl = (slug, season = 1, episode = 1) => `https://thecalm.site/shows/${slug}/season-${season}/episode-${episode}`;
const searchQuery = url => JSON.parse(new URL(url).searchParams.get('input')).query;
const isSearch = url => new URL(url).pathname === '/trpc/metadata.searchMedia';

test('an unmapped show is identified once by an exact TV match and cached separately across worker restarts', async () => {
  const requests = [];
  const h = setup(async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    if (isSearch(url)) {
      assert.equal(searchQuery(url), 'better call saul');
      return new Response(JSON.stringify(bcsSearch));
    }
    assert.equal(url, 'https://api.introdb.app/segments?imdb_id=tt3032476&season=1&episode=1');
    return new Response(JSON.stringify(bcsSegments));
  });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  const results = await Promise.all([
    h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup),
    h.runtime.dispatch({ type: 'GET_CONTEXT' }, h.frame),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'ready');
    assert.equal(result.context.imdbId, 'tt3032476');
    assert.equal(result.timings.segments.intro.start, 360.5);
    assert.equal(result.timings.segments.intro.end, 375);
  }
  assert.equal(requests.filter(isSearch).length, 1);
  assert.equal(requests.length, 2, 'simultaneous contexts coalesce both identification and timestamps');
  assert.equal(h.data.showMappings, undefined, 'automatic matches must not overwrite manual mappings');
  assert.equal(h.data.showIdentityCache['better-call-saul'].imdbId, 'tt3032476');
  assert.equal(JSON.stringify(h.data.showIdentityCache).includes('posterUrl'), false, 'poster metadata is not retained or fetched');
  const restarted = createBackgroundRuntime(h.chrome, async () => { throw new Error('cached show/timings must survive worker restart'); });
  const result = await restarted.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(result.status, 'ready');
  const authorized = await restarted.dispatch({ type: 'AUTHORIZE_SKIP', episodeKey: 'better-call-saul:1:1:tt3032476', segmentType: 'intro', currentTime: 361, duration: 3182 }, h.frame);
  assert.equal(authorized.authorized, true, JSON.stringify(authorized));
});

test('a correctly identified series without timestamps is missing coverage, not unidentified', async () => {
  const h = setup(async url => new Response(JSON.stringify(isSearch(url) ? simpsonsSearch : simpsonsSegments)));
  h.tabs.set(7, { id: 7, url: seriesUrl('the-simpsons', 13, 3) });
  const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(result.context.imdbId, 'tt0096697');
  assert.equal(result.context.season, 13);
  assert.equal(result.context.episode, 3);
  assert.equal(result.status, 'missing');
  assert.equal(result.timings.hasData, false);
});

test('ambiguous exact matches expose valid series choices and never select the first remake', async () => {
  let calls = 0;
  const h = setup(async url => {
    calls++;
    assert.equal(isSearch(url), true, 'an ambiguous match must never request another series timestamps');
    return new Response(JSON.stringify(ghostsSearch));
  });
  h.tabs.set(7, { id: 7, url: seriesUrl('ghosts') });
  const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(result.status, 'unidentified');
  assert.equal(result.context.imdbId, null);
  assert.equal(result.identificationStatus, 'ambiguous');
  assert.equal(result.identificationCandidates.length, 4);
  assert.ok(result.identificationCandidates.some(item => item.imdbId === 'tt11379026' && item.year === 2021));
  await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(calls, 1, 'ambiguity is cached instead of repeatedly searching during playback');
});

test('complete numeric titles take precedence over year suffixes, and explicit remake years disambiguate', async () => {
  for (const [slug, search, expected] of [
    ['space-1999', [{ source: 'imdb', displayTitle: 'Space: 1999', year: 1975, imdbId: 'tt0072564', mediaType: 'tv' }], 'tt0072564'],
    ['doctor-who-2005', [
      { source: 'imdb', displayTitle: 'Doctor Who', year: 1963, imdbId: 'tt0056751', mediaType: 'tv' },
      { source: 'imdb', displayTitle: 'Doctor Who', year: 2005, imdbId: 'tt0436992', mediaType: 'tv' },
    ], 'tt0436992'],
    ['ghosts-2021', ghostsSearch.result.data, 'tt11379026'],
  ]) {
    const h = setup(async url => isSearch(url) ? new Response(JSON.stringify({ result: { data: search } })) : new Response('', { status: 404 }));
    h.tabs.set(7, { id: 7, url: seriesUrl(slug) });
    const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
    assert.equal(result.context.imdbId, expected, slug);
    assert.equal(result.status, 'missing', slug);
  }
});

test('fuzzy results, movies, and invalid IDs do not identify a show, and negative lookups expire', async () => {
  let now = 1000, calls = 0;
  const h = setup(async url => {
    calls++;
    assert.equal(isSearch(url), true);
    return new Response(JSON.stringify({ result: { data: [
      { source: 'imdb', displayTitle: 'Unseen Plus', year: 2020, imdbId: 'tt1234567', mediaType: 'tv' },
      { source: 'imdb', displayTitle: 'Unseen', year: 2020, imdbId: 'tt7654321', mediaType: 'movie' },
      { source: 'imdb', displayTitle: 'Unseen', year: 2020, imdbId: 'bad', mediaType: 'tv' },
    ] } }));
  }, { now: () => now });
  h.tabs.set(7, { id: 7, url: seriesUrl('unseen') });
  assert.equal((await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup)).identificationStatus, 'not-found');
  await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(calls, 1);
  now += MISSING_TTL + 1;
  await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(calls, 2);
});

test('show-search failures and changed response shapes remain retryable and are never cached as missing', async () => {
  for (const fetcher of [
    async () => { throw new TypeError('offline'); },
    async () => new Response('', { status: 503 }),
    async () => new Response('not-json'),
    async () => new Response(JSON.stringify({ result: { data: { unexpected: [] } } })),
    async () => new Response('x'.repeat(128001)),
  ]) {
    let calls = 0;
    const h = setup(async () => { calls++; return fetcher(); });
    h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
      assert.equal(result.status, 'error');
      assert.equal(result.identificationStatus, 'error');
      assert.equal(result.context.imdbId, null);
      assert.equal(h.data.showIdentityCache, undefined);
    }
    assert.equal(calls, 2);
  }
});

test('show identification times out without creating a negative cache record', async () => {
  const h = setup((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 5 });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(result.status, 'error');
  assert.match(result.error, /identification timed out/);
  assert.equal(h.data.showIdentityCache, undefined);
});

test('a manual mapping made during a slow automatic lookup wins before timings or authorization', async () => {
  let release;
  const segmentRequests = [];
  const h = setup(async url => {
    if (isSearch(url)) {
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ result: { data: [{ source: 'imdb', displayTitle: 'Better Call Saul', year: 2015, imdbId: 'tt9999999', mediaType: 'tv' }] } }));
    }
    segmentRequests.push(new URL(url).searchParams.get('imdb_id'));
    return new Response(JSON.stringify(bcsSegments));
  });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  const pending = h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.runtime.dispatch({ type: 'SET_MAPPING', tabId: 7, slug: 'better-call-saul', imdbId: 'tt3032476' }, h.popup);
  release();
  const result = await pending;
  assert.equal(result.context.imdbId, 'tt3032476');
  assert.equal(h.data.showMappings['better-call-saul'], 'tt3032476');
  assert.deepEqual(segmentRequests, ['tt3032476']);
  const authorized = await h.runtime.dispatch({ type: 'AUTHORIZE_SKIP', episodeKey: 'better-call-saul:1:1:tt3032476', segmentType: 'intro', currentTime: 361, duration: 3182 }, h.frame);
  assert.equal(authorized.authorized, true);
});

test('navigation during show lookup discards the old context before requesting its timings', async () => {
  let release;
  const segmentRequests = [];
  const h = setup(async url => {
    if (isSearch(url)) {
      if (searchQuery(url) === 'better call saul') {
        await new Promise(resolve => { release = resolve; });
        return new Response(JSON.stringify(bcsSearch));
      }
      return new Response(JSON.stringify(simpsonsSearch));
    }
    segmentRequests.push(new URL(url).searchParams.get('imdb_id'));
    return new Response(JSON.stringify(simpsonsSegments));
  });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  const pending = h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.tabs.set(7, { id: 7, url: seriesUrl('the-simpsons', 13, 3) });
  release();
  const result = await pending;
  assert.equal(result.context.imdbId, 'tt0096697');
  assert.equal(result.status, 'missing');
  assert.deepEqual(segmentRequests, ['tt0096697']);
});

test('identity cache writes merge parallel shows and evict old entries at their size bound', async () => {
  const identities = {};
  for (let i = 0; i < 100; i++) identities[`cached-${i}`] = { schema: 1, slug: `cached-${i}`, status: 'matched', imdbId: 'tt1234567', fetchedAt: i, expiresAt: CACHE_TTL };
  const h = setup(async url => isSearch(url) ? new Response(JSON.stringify(searchQuery(url) === 'better call saul' ? bcsSearch : simpsonsSearch)) :
    new Response(JSON.stringify(new URL(url).searchParams.get('imdb_id') === 'tt3032476' ? bcsSegments : simpsonsSegments)), { now: () => 1000, initialData: { showIdentityCache: identities } });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  h.tabs.set(9, { id: 9, url: seriesUrl('the-simpsons', 13, 3) });
  const result = await Promise.all([h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup), h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 9 }, h.popup)]);
  assert.equal(result[0].status, 'ready');
  assert.equal(result[1].status, 'missing');
  assert.equal(Object.keys(h.data.showIdentityCache).length, 100);
  assert.equal(h.data.showIdentityCache['cached-0'], undefined);
  assert.equal(h.data.showIdentityCache['cached-1'], undefined);
  assert.equal(h.data.showIdentityCache['better-call-saul'].imdbId, 'tt3032476');
  assert.equal(h.data.showIdentityCache['the-simpsons'].imdbId, 'tt0096697');
});

test('punctuated acronyms match their normal site slugs without fuzzy title selection', async () => {
  for (const [slug, title, imdbId] of [
    ['swat', 'S.W.A.T.', 'tt6111130'],
    ['the-oc', 'The O.C.', 'tt0362359'],
    ['agents-of-shield', 'Agents of S.H.I.E.L.D.', 'tt2364582'],
  ]) {
    const h = setup(async url => isSearch(url) ? new Response(JSON.stringify({ result: { data: [
      { source: 'imdb', displayTitle: title + ': Behind the Scenes', year: 2020, imdbId: 'tt9999999', mediaType: 'tv' },
      { source: 'imdb', displayTitle: title, year: 2010, imdbId, mediaType: 'tv' },
    ] } })) : new Response('', { status: 404 }));
    h.tabs.set(7, { id: 7, url: seriesUrl(slug) });
    assert.equal((await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup)).context.imdbId, imdbId, slug);
  }
});

test('late metadata and independent mapping writes preserve an explicit series choice', async () => {
  const h = setup(async url => {
    assert.equal(isSearch(url), false, 'primary or manual identity must not need a name lookup');
    return new Response(JSON.stringify(bcsSegments));
  }, { initialData: { settingsSchemaVersion: SETTINGS_SCHEMA_VERSION } });
  h.tabs.set(7, { id: 7, url: seriesUrl('better-call-saul') });
  const set = h.chrome.storage.local.set;
  let release;
  h.chrome.storage.local.set = async value => {
    if (value.showMappings?.['better-call-saul'] === 'tt9999999') await new Promise(resolve => { release = resolve; });
    return set(value);
  };
  const automatic = h.runtime.dispatch({ type: 'SET_EPISODE', url: seriesUrl('better-call-saul'), imdbId: 'tt9999999' }, h.top);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const manual = h.runtime.dispatch({ type: 'SET_MAPPING', tabId: 7, slug: 'better-call-saul', imdbId: 'tt3032476' }, h.popup);
  release();
  await Promise.all([automatic, manual]);
  assert.equal(h.data.showMappings['better-call-saul'], 'tt3032476');
  // Metadata received after the user's write must also keep that selection.
  await h.runtime.dispatch({ type: 'SET_EPISODE', url: seriesUrl('better-call-saul'), imdbId: 'tt9999999' }, h.top);
  assert.equal(h.data.showMappings['better-call-saul'], 'tt3032476');
  const result = await h.runtime.dispatch({ type: 'GET_CONTEXT', tabId: 7 }, h.popup);
  assert.equal(result.context.imdbId, 'tt3032476');
  assert.equal(result.status, 'ready');
});
