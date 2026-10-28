"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const Core = require("../extension/shared.js");

const TOP_URL = "https://thecalm.site/shows/prison-break/season-1/episode-18";
const EMBED_URL = "https://player.example/embed/episode?token=browser-only-query-value";
const HISTORY_URL = "https://player.example/watch/episode";

function harness() {
  const session = {};
  const state = {
    now: 1000,
    documentId: "top-document-a",
    candidates: [{ url: EMBED_URL, visible: true }],
    frames: [
      { frameId: 0, parentFrameId: -1, url: TOP_URL },
      { frameId: 11, parentFrameId: 0, url: EMBED_URL, documentId: "player-document-a" },
    ],
    calls: { tabs: 0, frames: 0, candidates: 0, injections: [], probes: [], permissions: 0 },
    probePaths: {},
    granted: true,
  };
  const event = () => {
    const listeners = [];
    return { addListener(listener) { listeners.push(listener); }, async emit(value) { await Promise.all(listeners.map(listener => listener(value))); } };
  };
  const completed = event();
  const storage = {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(session);
      const selected = {};
      for (const key of typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (Object.hasOwn(session, key)) selected[key] = structuredClone(session[key]);
        else if (keys && !Array.isArray(keys) && typeof keys === "object") selected[key] = structuredClone(keys[key]);
      }
      return selected;
    },
    async set(values) { Object.assign(session, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
  };
  function frameRecords() {
    return state.frames.map(frame => structuredClone(frame.frameId === 0 ? { ...frame, documentId: state.documentId } : frame));
  }
  const chrome = {
    runtime: { id: "players-test-extension" },
    storage: { session: storage },
    tabs: {
      async get(tabId) { state.calls.tabs++; assert.equal(tabId, 1); return { id: tabId, url: TOP_URL }; },
      async sendMessage(tabId, message, options) {
        assert.equal(tabId, 1);
        assert.equal(message.type, "GET_FRAME_CANDIDATES");
        assert.equal(options.frameId, 0);
        state.calls.candidates++;
        return { candidates: structuredClone(state.candidates) };
      },
      onRemoved: event(),
    },
    permissions: { async contains(request) { state.calls.permissions++; return state.allowedOrigins ? request.origins.every(origin => state.allowedOrigins.has(origin)) : state.granted; } },
    webNavigation: {
      async getAllFrames({ tabId }) {
        state.calls.frames++; assert.equal(tabId, 1);
        const records = frameRecords();
        if (state.frameReadPending) {
          const pending = state.frameReadPending; state.frameReadPending = null;
          await pending;
        }
        return records;
      },
      async getFrame({ tabId, frameId }) {
        assert.equal(tabId, 1);
        return frameRecords().find(frame => frame.frameId === frameId) || null;
      },
      onCompleted: completed,
      onCommitted: event(),
      onBeforeNavigate: event(),
    },
    scripting: { async executeScript(details) {
      if (details.func) {
        state.calls.probes.push(structuredClone(details.target));
        const records = details.target.frameIds.map(id => ({ frameId: id, documentId: state.frames.find(frame => frame.frameId === id)?.documentId, result: state.probePaths[id] || null }));
        if (state.probeHook) state.probeHook();
        return records;
      }
      state.calls.injections.push(structuredClone(details));
      if (state.injectPending) await state.injectPending;
      if (state.injectFailures > 0) { state.injectFailures--; throw new Error("Player is still loading"); }
    } },
  };

  function worker() {
    const source = fs.readFileSync(path.join(__dirname, "../extension/players.js"), "utf8");
    const context = vm.createContext({
      chrome, CalmSkip: Core, URL, TextEncoder, crypto: webcrypto,
      Date: class extends Date { static now() { return state.now; } },
      structuredClone, setTimeout, clearTimeout,
    });
    vm.runInContext(source, context, { filename: "players.js" });
    return context.CalmPlayers;
  }

  return { state, session, worker, completed, expireCache() { state.now += 600; } };
}

async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error("Timed out waiting for background connection.");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("verified visible player stays associated when its child URL changes", async () => {
  const h = harness();
  const players = h.worker();
  assert.equal(await players.isVisibleFrame(1, 11), true);
  h.state.frames[1].url = HISTORY_URL;
  h.expireCache();
  assert.equal(await players.isVisibleFrame(1, 11), true, "history changes do not change the visible iframe element");
});

test("verified frame associations survive worker restart without saving embed URLs", async () => {
  const h = harness();
  assert.equal(await h.worker().isVisibleFrame(1, 11), true);
  assert.ok(Object.keys(h.session).length > 0, "the association must be stored in browser-session storage");
  const serialized = JSON.stringify(h.session);
  assert.equal(serialized.includes(EMBED_URL), false, "raw iframe URLs must not be persisted");
  assert.equal(serialized.includes("browser-only-query-value"), false, "query tokens must not be persisted");
  h.state.frames[1].url = HISTORY_URL;
  h.expireCache();
  assert.equal(await h.worker().isVisibleFrame(1, 11), true, "a new worker recovers the verified association");
});

test("hiding a verified parent revokes its player and nested descendant", async () => {
  const h = harness();
  h.state.frames.push({ frameId: 12, parentFrameId: 11, url: "https://nested.example/player", documentId: "nested-document" });
  const players = h.worker();
  assert.equal(await players.isVisibleFrame(1, 11), true);
  assert.equal(await players.isVisibleFrame(1, 12), true);
  h.state.frames[1].url = HISTORY_URL;
  h.state.candidates[0].visible = false;
  h.expireCache();
  assert.equal(await players.isVisibleFrame(1, 11), false);
  assert.equal(await players.isVisibleFrame(1, 12), false, "a child cannot claim visibility through a hidden root");
});

test("a visible root does not authorize its hidden same-origin sibling", async () => {
  const h = harness();
  h.state.frames.push({ frameId: 13, parentFrameId: 0, url: HISTORY_URL, documentId: "hidden-player-document" });
  h.state.candidates.push({ url: HISTORY_URL, visible: false });
  const players = h.worker();
  assert.equal(await players.isVisibleFrame(1, 11), true);
  assert.equal(await players.isVisibleFrame(1, 13), false);
  h.state.frames[1].url = HISTORY_URL;
  h.expireCache();
  assert.equal(await players.isVisibleFrame(1, 11), true);
  assert.equal(await players.isVisibleFrame(1, 13), false, "association follows the verified frame ID, not its origin or new URL");
});

test("a new top document invalidates associations even when frame IDs are reused", async () => {
  const h = harness();
  assert.equal(await h.worker().isVisibleFrame(1, 11), true);
  h.state.frames[1].url = HISTORY_URL;
  h.state.documentId = "top-document-b";
  h.expireCache();
  assert.equal(await h.worker().isVisibleFrame(1, 11), false, "a new document needs its own initial exact-source verification");
});

test("an unverified iframe is not trusted solely because its origin matches", async () => {
  const h = harness();
  h.state.frames[1].url = HISTORY_URL;
  assert.equal(await h.worker().isVisibleFrame(1, 11), false);
});

test("unrelated HTTPS pages never query tabs, frames, or player scripts", async () => {
  const h = harness();
  h.worker();
  for (let tabId = 2; tabId < 52; tabId++) {
    await h.completed.emit({ tabId, frameId: 0, url: `https://other.example/page-${tabId}`, documentId: `other-${tabId}` });
    await h.completed.emit({ tabId, frameId: 17, url: "https://player.example/embed/unrelated", documentId: `frame-${tabId}` });
  }
  assert.equal(h.state.calls.tabs, 0);
  assert.equal(h.state.calls.frames, 0);
  assert.equal(h.state.calls.candidates, 0);
  assert.equal(h.state.calls.permissions, 0);
  assert.equal(h.state.calls.injections.length, 0);
});

test("tracking is nonblocking and repeated completion injects an existing document once", async () => {
  const h = harness();
  const players = h.worker();
  assert.equal(players.trackTab({ id: 1, url: TOP_URL }), undefined);
  await until(() => h.state.calls.injections.length === 1);
  const completed = { tabId: 1, frameId: 11, url: EMBED_URL, documentId: "player-document-a" };
  await h.completed.emit(completed);
  await h.completed.emit(completed);
  assert.equal(h.state.calls.injections.length, 1);
  assert.deepEqual(h.state.calls.injections[0].target.frameIds, [11]);
});

test("a child navigation injects only its new document, not every granted sibling", async () => {
  const h = harness();
  h.state.frames.push({ frameId: 12, parentFrameId: 11, url: "https://nested.example/player", documentId: "nested-document-a" });
  const players = h.worker();
  players.trackTab({ id: 1, url: TOP_URL });
  await until(() => h.state.calls.injections.length === 2);
  h.state.frames[1].documentId = "player-document-b";
  h.expireCache();
  await h.completed.emit({ tabId: 1, frameId: 11, url: EMBED_URL, documentId: "player-document-b" });
  assert.equal(h.state.calls.injections.length, 3);
  assert.deepEqual(h.state.calls.injections.at(-1).target.frameIds, [11]);
});

test("concurrent navigation events coalesce in-flight document injection", async () => {
  const h = harness();
  const players = h.worker();
  players.trackTab({ id: 1, url: TOP_URL });
  await until(() => h.state.calls.injections.length === 1);
  h.state.frames[1].documentId = "player-document-b";
  h.expireCache();
  let release;
  h.state.injectPending = new Promise(resolve => { release = resolve; });
  const completed = { tabId: 1, frameId: 11, url: EMBED_URL, documentId: "player-document-b" };
  const events = Array.from({ length: 8 }, () => h.completed.emit(completed));
  await until(() => h.state.calls.injections.length === 2);
  release();
  await Promise.all(events);
  assert.equal(h.state.calls.injections.length, 2, "only one injection is allowed for the pending document");
});

test("ungranted iframe completion does not enumerate every frame again", async () => {
  const h = harness();
  const players = h.worker();
  players.trackTab({ id: 1, url: TOP_URL });
  await until(() => h.state.calls.injections.length === 1);
  const before = h.state.calls.frames;
  h.state.granted = false;
  await h.completed.emit({ tabId: 1, frameId: 12, url: "https://ads.example/frame", documentId: "ad-document" });
  assert.equal(h.state.calls.frames, before);
  assert.equal(h.state.calls.injections.length, 1);
});

test("explicit player discovery refreshes a cached empty frame list immediately", async () => {
  const h = harness();
  const playerFrame = h.state.frames.pop();
  h.state.candidates = [];
  const players = h.worker();
  assert.equal(await players.isVisibleFrame(1, 11), false);
  h.state.frames.push(playerFrame);
  h.state.candidates.push({ url: EMBED_URL, visible: true });
  const response = await players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.ok, true);
  assert.equal(response.playerOrigins.length, 1);
  assert.equal(response.playerOrigins[0].origin, "https://player.example");
});

test("interactive discovery refreshes after an older empty scan still in flight", async () => {
  const h = harness();
  const playerFrame = h.state.frames.pop();
  h.state.candidates = [];
  let release;
  h.state.frameReadPending = new Promise(resolve => { release = resolve; });
  const players = h.worker();
  const old = players.isVisibleFrame(1, 11);
  await until(() => h.state.calls.frames === 1);
  h.state.frames.push(playerFrame);
  h.state.candidates.push({ url: EMBED_URL, visible: true });
  const refresh = players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  release();
  assert.equal(await old, false);
  const result = await refresh;
  assert.equal(result.playerOrigins[0]?.origin, "https://player.example");
  assert.equal(h.state.calls.frames, 2);
});

test("a permitted redirected player is verified by its actual DOM index and reconnects on popup discovery", async () => {
  const h = harness();
  h.state.candidates[0].frameIndex = 0;
  h.state.frames[1].url = HISTORY_URL;
  h.state.probePaths[11] = [0];
  const players = h.worker();
  const response = await players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.connectedFrames, 1);
  assert.equal(response.playerOrigins[0].origin, "https://player.example");
  assert.equal(await players.isVisibleFrame(1, 11), true);
  assert.equal(h.state.calls.probes.length, 1);
  assert.equal(h.state.calls.injections.length, 1, "a popup lookup repairs a missed automatic injection");
  assert.equal(JSON.stringify(h.session).includes(EMBED_URL), false);
});

test("redirect probes distinguish a visible player from its hidden same-origin sibling", async () => {
  const h = harness();
  h.state.frames[1].url = "https://player.example/hidden-final";
  h.state.frames.push({ frameId: 13, parentFrameId: 0, url: HISTORY_URL, documentId: "visible-redirect-document" });
  h.state.candidates = [{ url: "https://player.example/hidden-start", frameIndex: 0, visible: false }, { url: EMBED_URL, frameIndex: 1, visible: true }];
  h.state.probePaths = { 11: [0], 13: [1] };
  const players = h.worker();
  const response = await players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.connectedFrames, 1);
  assert.equal(await players.isVisibleFrame(1, 11), false);
  assert.equal(await players.isVisibleFrame(1, 13), true);
  assert.deepEqual(h.state.calls.injections[0].target.frameIds, [13]);
});

test("an allowed nested player proves its visible redirected wrapper without granting the wrapper", async () => {
  const h = harness();
  h.state.candidates = [{ url: "https://wrapper.example/start", frameIndex: 0, visible: true }];
  h.state.frames[1].url = "https://wrapper.example/final";
  h.state.frames.push({ frameId: 12, parentFrameId: 11, url: "https://player.example/nested", documentId: "nested-allowed-document" });
  h.state.allowedOrigins = new Set(["https://player.example/*"]);
  h.state.probePaths[12] = [0, 0];
  const players = h.worker();
  const response = await players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.connectedFrames, 1);
  assert.equal(await players.isVisibleFrame(1, 12), true);
  assert.deepEqual(h.state.calls.probes[0].frameIds, [12]);
  assert.deepEqual(h.state.calls.injections[0].target.frameIds, [12]);
  assert.equal(response.playerOrigins.find(item => item.origin === "https://wrapper.example").granted, false);
});

test("redirect probes reject reloads and iframe reorderings that invalidate their snapshot", async () => {
  for (const change of ["top-document", "player-document", "frame-order", "source", "hidden"]) {
    const h = harness();
    h.state.candidates[0].frameIndex = 0;
    h.state.frames[1].url = HISTORY_URL;
    h.state.probePaths[11] = [0];
    h.state.probeHook = () => {
      if (change === "top-document") h.state.documentId = "new-top-document";
      if (change === "player-document") h.state.frames[1].documentId = "new-player-document";
      if (change === "frame-order") h.state.candidates[0].frameIndex = 1;
      if (change === "source") h.state.candidates[0].url = "https://player.example/other-source";
      if (change === "hidden") h.state.candidates[0].visible = false;
    };
    const response = await h.worker().handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
    assert.equal(response.connectedFrames, 0, change);
    assert.equal(h.state.calls.injections.length, 0, change);
  }
});

test("redirect probing requires an existing host grant", async () => {
  const h = harness();
  h.state.candidates[0].frameIndex = 0;
  h.state.frames[1].url = HISTORY_URL;
  h.state.probePaths[11] = [0];
  h.state.granted = false;
  const response = await h.worker().handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.connectedFrames, 0);
  assert.equal(h.state.calls.probes.length, 0);
  assert.equal(h.state.calls.injections.length, 0);
});

test("opening the popup retries an earlier failed injection in an already tracked episode", async () => {
  const h = harness();
  h.state.injectFailures = 1;
  const players = h.worker();
  players.trackTab({ id: 1, url: TOP_URL });
  await until(() => h.state.calls.injections.length === 1);
  const response = await players.handleMessage({ type: "PLAYER_ORIGINS", tabId: 1 });
  assert.equal(response.connectedFrames, 1);
  assert.equal(h.state.calls.injections.length, 2);
});
