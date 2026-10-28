'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { createBackgroundRuntime } = require('../extension/background.js');
const fixture = require('./fixtures/prison-break-s01e18.json');

const EPISODE_URL = 'https://thecalm.site/shows/prison-break/season-1/episode-18';
const EXTENSION = path.resolve(__dirname, '../extension');
const EXTENSION_ID = 'thecalm-browser-harness';
const POPUP_URL = 'https://extension.thecalm-fixture.test/popup.html';

// Real seekable media, not a stubbed HTMLMediaElement. A silent PCM track
// avoids including or downloading a film. Production media is never captured.
function silence(duration = 2639) {
  const sampleRate = 8000;
  const bytes = duration * sampleRate;
  const wav = Buffer.alloc(44 + bytes, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  return wav;
}

async function until(predicate, label, timeout = 8000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await delay(60);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

const runtimeShim = `
(() => {
  const listeners = [];
  const metrics = globalThis.__calmTestMetrics = { fullDomScans: 0, videoScans: 0, messages: {} };
  for (const prototype of [Document.prototype, ShadowRoot.prototype]) {
    const original = prototype.querySelectorAll;
    prototype.querySelectorAll = function (selector) {
      if (selector === '*') metrics.fullDomScans++;
      if (typeof selector === 'string' && /(^|[,\\s])video(?=$|[,\\s])/.test(selector)) metrics.videoScans++;
      return original.call(this, selector);
    };
  }
  const originalWalker = Document.prototype.createTreeWalker;
  Document.prototype.createTreeWalker = function (root, ...options) {
    if (root === this || root === this.documentElement || root === this.body) metrics.fullDomScans++;
    return originalWalker.call(this, root, ...options);
  };
  globalThis.chrome = {
    runtime: {
      id: ${JSON.stringify(EXTENSION_ID)},
      getURL: file => 'chrome-extension://${EXTENSION_ID}/' + file,
      sendMessage: message => {
        metrics.messages[message.type] = (metrics.messages[message.type] || 0) + 1;
        return globalThis.__calmBridge(message);
      },
      onMessage: { addListener: listener => listeners.push(listener) }
    },
    tabs: {
      query: () => globalThis.__calmBridge({ type: '__TEST_QUERY_TABS' }),
      sendMessage: (tabId, message, options) => globalThis.__calmBridge({ type: '__TEST_TAB_MESSAGE', tabId, message, options })
    },
    permissions: {
      request: request => globalThis.__calmBridge({ type: '__TEST_GRANT_PERMISSION', request }),
      contains: request => globalThis.__calmBridge({ type: '__TEST_HAS_PERMISSION', request })
    }
  };
  globalThis.__calmDeliver = message => new Promise(resolve => {
    let responded = false;
    let asynchronous = false;
    const respond = value => { if (!responded) { responded = true; resolve(value); } };
    for (const listener of listeners) {
      if (listener(message, { id: '${EXTENSION_ID}' }, respond) === true) asynchronous = true;
    }
    if (!asynchronous && !responded) resolve(undefined);
  });
})();
`;

// Managed Chromium in this cloud machine blocks installing non-platform
// extensions. This harness executes the real shared/content/popup code against
// real browser media, and the real background dispatcher in Node. Only Chrome
// transport/storage/host-grant APIs and provider HTTP responses are simulated.
// It does not establish that the packaged extension was installed in Chromium.
test('content, popup and background integration with real browser media', { timeout: 120000 }, async t => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext();
  let page;
  const frames = new Map();
  let nextFrameId = 1;
  const storage = {};
  const sessionStorage = {};
  const permissions = new Set();
  const tabUpdated = [];
  let embeddedReportDelay = 0;
  let dropEmbeddedReports = false;
  const noopEvent = { addListener() {} };
  function frameId(frame) {
    if (frame === page.mainFrame()) return 0;
    if (!frames.has(frame)) frames.set(frame, nextFrameId++);
    return frames.get(frame);
  }
  function getFrame(id = 0) {
    return id === 0 ? page.mainFrame() : [...frames].find(([, value]) => value === id)?.[0];
  }
  async function deliver(id, message) {
    const frame = getFrame(id);
    if (!frame || frame.isDetached()) throw new Error('Player frame disappeared.');
    return frame.evaluate(message => globalThis.__calmDeliver(message), message);
  }
  const chromeApi = {
    runtime: { id: EXTENSION_ID, getURL: file => `chrome-extension://${EXTENSION_ID}/${file}`, onMessage: noopEvent },
    storage: { local: {
      async get(keys) {
        const result = {};
        for (const key of typeof keys === 'string' ? [keys] : keys) if (key in storage) result[key] = structuredClone(storage[key]);
        return result;
      },
      async set(values) { Object.assign(storage, structuredClone(values)); }
    }, session: {
      async get(keys) {
        const result = {};
        for (const key of keys == null ? Object.keys(sessionStorage) : typeof keys === 'string' ? [keys] : keys) {
          if (key in sessionStorage) result[key] = structuredClone(sessionStorage[key]);
        }
        return result;
      },
      async set(values) { Object.assign(sessionStorage, structuredClone(values)); },
      async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete sessionStorage[key]; }
    } },
    tabs: {
      async get(id) { assert.equal(id, 1); return { id: 1, url: page.url() }; },
      async query() { return [{ id: 1, url: page.url() }]; },
      async sendMessage(id, message, options = {}) {
        assert.equal(id, 1);
        if (options.frameId !== undefined) return deliver(options.frameId, message);
        const values = await Promise.all(page.frames().map(async frame => {
          try { return await deliver(frameId(frame), message); } catch { return undefined; }
        }));
        return values.find(value => value !== undefined);
      },
      onRemoved: noopEvent,
      onUpdated: { addListener(listener) { tabUpdated.push(listener); } }
    },
    permissions: { async contains(request) { return request.origins.every(origin => permissions.has(origin)); } },
    webNavigation: {
      async getAllFrames() {
        return page.frames().map(frame => ({ frameId: frameId(frame), parentFrameId: frame.parentFrame() ? frameId(frame.parentFrame()) : -1, url: frame.url() }));
      },
      onCompleted: noopEvent
    },
    scripting: {
      async executeScript({ target, files }) {
        for (const id of target.frameIds) {
          const frame = getFrame(id);
          assert.ok(frame, 'injected frame must exist');
          for (const file of files) await frame.addScriptTag({ path: path.join(EXTENSION, file) });
        }
      }
    }
  };
  globalThis.chrome = chromeApi;
  require('../extension/players.js');
  const runtime = createBackgroundRuntime(chromeApi, async () => new Response(JSON.stringify({ error: 'No segments found' }), { status: 404 }));
  runtime.install();
  const popupSender = { id: EXTENSION_ID, url: chromeApi.runtime.getURL('popup.html') };
  async function message(type, extra = {}) { return runtime.dispatch({ type, tabId: 1, ...extra }, popupSender); }
  async function playerStatus() {
    const response = await deliver(0, { type: 'GET_PLAYER_STATUS' });
    return response.player || response;
  }
  async function currentTime(target = page.mainFrame()) { return target.locator('video').evaluate(video => video.currentTime); }
  async function seek(time, playing = true, target = page.mainFrame()) {
    await target.evaluate(async ({ time, playing }) => {
      const video = document.querySelector('video');
      if (video.readyState === 0) await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
      video.currentTime = time;
      if (playing) await video.play(); else video.pause();
    }, { time, playing });
  }
  try {
    const html = await fs.readFile(path.join(__dirname, 'fixtures/episode.html'), 'utf8');
    const shared = await fs.readFile(path.join(EXTENSION, 'shared.js'), 'utf8');
    const content = await fs.readFile(path.join(EXTENSION, 'content.js'), 'utf8');
    const media = silence();
    const differentMedia = silence(2700);
    const shortCreditMedia = silence(2600);
    async function mediaRoute(route) {
      const url = new URL(route.request().url());
      const body = url.searchParams.has('short-credits') ? shortCreditMedia : url.searchParams.has('different') ? differentMedia : media;
      const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      await route.fulfill({
        status: match ? 206 : 200,
        headers: {
          'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
          ...(match ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {})
        },
        body: body.subarray(start, end + 1)
      });
    }
    const homepage = '<!doctype html><html><body><h1>TheCalm home fixture</h1><div id="ticker">0</div>' + '<div class="card"><span>Show</span></div>'.repeat(10000) + '</body></html>';
    await context.route('https://thecalm.site/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      return pathname === '/fixture-media.wav' ? mediaRoute(route) : route.fulfill({ status: 200, contentType: 'text/html', body: pathname === '/' ? homepage : html });
    });
    await context.route('https://player.thecalm-fixture.test/**', route => new URL(route.request().url()).pathname === '/fixture-media.wav' ? mediaRoute(route) : route.fulfill({ status: 200, contentType: 'text/html', body: html.replace(/<a id="next-episode"[\s\S]*?<\/a>/, '') }));
    await context.route('https://ads.thecalm-fixture.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>Unrelated ad frame</body></html>' }));
    await context.route('https://extension.thecalm-fixture.test/**', async route => {
      const filename = path.basename(new URL(route.request().url()).pathname);
      if (!['popup.html', 'popup.css', 'popup.js', 'shared.js'].includes(filename)) return route.abort();
      await route.fulfill({ contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'application/javascript', body: await fs.readFile(path.join(EXTENSION, filename)) });
    });
    await context.exposeBinding('__calmBridge', async (source, request) => {
      if (request.type === '__TEST_QUERY_TABS') return [{ id: 1, url: page.url() }];
      if (request.type === '__TEST_TAB_MESSAGE') return chromeApi.tabs.sendMessage(request.tabId, request.message, request.options);
      if (request.type === '__TEST_HAS_PERMISSION') return chromeApi.permissions.contains(request.request);
      if (request.type === '__TEST_GRANT_PERMISSION') {
        for (const origin of request.request.origins) permissions.add(origin);
        return true;
      }
      const sender = new URL(source.frame.url()).hostname === 'extension.thecalm-fixture.test' ? popupSender : {
        id: EXTENSION_ID, url: source.frame.url(), frameId: frameId(source.frame), tab: { id: 1, url: page.url() }
      };
      if (request.type === 'REPORT_STATUS' && sender.frameId > 0 && dropEmbeddedReports) return { ok: false, error: 'Simulated dropped status telemetry' };
      if (request.type === 'REPORT_STATUS' && sender.frameId > 0 && embeddedReportDelay) await delay(embeddedReportDelay);
      return runtime.dispatch(request, sender);
    });
    await context.addInitScript({ content: runtimeShim + `\nif (location.hostname === 'thecalm.site' && window === window.top) document.addEventListener('DOMContentLoaded', () => {\n${shared}\n${content}\n}, { once: true });` });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) for (const listener of tabUpdated) listener(1, { url: frame.url() });
    });
    await t.test('non-episode pages do no player discovery or metadata polling during text mutations', async () => {
      await page.goto('https://thecalm.site/');
      await page.evaluate(() => {
        const ticker = document.getElementById('ticker');
        let count = 0;
        window.__calmTextStorm = setInterval(() => { ticker.textContent = String(++count); }, 25);
      });
      await delay(2200);
      const metrics = await page.evaluate(() => {
        clearInterval(window.__calmTextStorm);
        return structuredClone(window.__calmTestMetrics);
      });
      assert.equal(metrics.fullDomScans, 0, 'browsing a large homepage must not walk every element');
      assert.equal(metrics.videoScans, 0, 'non-episode pages must not scan for players');
      assert.equal(metrics.messages.GET_CONTEXT || 0, 0, 'homepage must not poll episode metadata');
      assert.equal(metrics.messages.REPORT_STATUS || 0, 0, 'homepage must not emit player telemetry');
    });

    await page.goto(EPISODE_URL);
    await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'real media metadata');
    await until(async () => (await playerStatus()).videoFound, 'content video detection');

    await t.test('fresh settings skip automatically and show a brief toast without a skip-button click', async () => {
      const initial = await message('GET_CONTEXT');
      assert.equal(initial.settings.enabled, true, 'automatic skipping must be the first-run default');
      const imported = await message('IMPORT_TIMINGS', { data: fixture });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      assert.equal(imported.context.episode, 18);
      assert.equal(imported.timings.segments.intro.start, 269);
      await seek(0.1);
      await until(async () => (await currentTime()) >= 52, 'default automatic recap skip');
      assert.ok(await currentTime() < 55, 'skip must seek to the actual recap endpoint');
      const overlay = page.locator('#thecalm-skip-overlay');
      const panel = overlay.locator('section');
      await until(async () => (await overlay.locator('[role="status"]').innerText()).includes('Skipped recap'), 'post-skip recap toast');
      assert.equal(await overlay.locator('#skip-segment').count(), 0, 'automatic skip must not require a skip-button click');
      await panel.screenshot({ path: '/tmp/thecalm-auto-skip-toast.png' });
      await page.locator('video').evaluate(video => video.pause());
      await until(() => panel.isHidden(), 'toast to dismiss after a few seconds', 4500);
      assert.equal((await playerStatus()).canUndo, true, 'undo must remain available after the brief toast disappears');
      const undone = await message('UNDO_SKIP');
      assert.equal(undone.ok, true, JSON.stringify(undone));
      assert.ok(await currentTime() < 3, 'popup undo still restores the pre-skip position after toast dismissal');
    });

    await t.test('an explicit pause of automatic skipping leaves playback unchanged', async () => {
      const paused = await message('SET_SETTINGS', { settings: { enabled: false } });
      assert.equal(paused.ok, true, JSON.stringify(paused));
      assert.equal(paused.settings.enabled, false);
      await page.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'fresh media after explicit pause');
      await seek(0.1); await delay(400);
      assert.ok(await currentTime() < 3, 'explicitly paused automatic skipping must not skip the recap');
      await until(async () => (await playerStatus()).safety.ok, 'matching duration check');
    });

    await t.test('popup displays the imported timings and enables automatic mode', async () => {
      const popup = await context.newPage();
      popup.on('pageerror', error => errors.push(error.message));
      await popup.goto(POPUP_URL);
      await until(async () => (await popup.locator('body').innerText()).includes('4:29'), 'popup timing display');
      assert.match(await popup.locator('body').innerText(), /0:52/);
      if (process.env.CALM_SCREENSHOT) await popup.locator('body').screenshot({ path: process.env.CALM_SCREENSHOT });
      await popup.close(); await page.bringToFront();
      const enabled = await message('SET_SETTINGS', { settings: { enabled: true } });
      assert.equal(enabled.ok, true, JSON.stringify(enabled));
    });

    await t.test('automatic recap and intro skips preserve story content and support undo', async () => {
      await until(async () => (await currentTime()) >= 52, 'recap skip');
      assert.ok(await currentTime() < 55);
      await seek(110); await delay(400);
      const coldOpen = await currentTime();
      assert.ok(coldOpen >= 110 && coldOpen < 113, `cold-open story must remain: ${coldOpen}`);
      await seek(269.1);
      await until(async () => (await currentTime()) >= 302, 'intro skip');
      assert.ok(await currentTime() < 305);
      const undone = await message('UNDO_SKIP');
      assert.equal(undone.ok, true, JSON.stringify(undone));
      await until(async () => (await currentTime()) < 273, 'undo restore');
      await delay(500);
      assert.ok(await currentTime() < 274, 'undo suppresses immediate re-skip');
    });

    await t.test('playing episodes ignore text-only mutation storms without repeated full-page scans', async () => {
      await seek(110);
      await page.evaluate(() => {
        const container = document.createElement('div');
        container.hidden = true;
        for (let i = 0; i < 10000; i++) container.append(document.createElement('span'));
        const ticker = document.createElement('div');
        ticker.id = 'performance-ticker';
        document.body.append(container, ticker);
      });
      // Let the one structural mutation settle before measuring text updates.
      await delay(500);
      await page.evaluate(() => {
        const metrics = window.__calmTestMetrics;
        metrics.fullDomScans = 0; metrics.videoScans = 0; metrics.messages = {};
        const ticker = document.getElementById('performance-ticker');
        let count = 0;
        window.__calmTextStorm = setInterval(() => { ticker.textContent = String(++count); }, 25);
      });
      await delay(2200);
      const metrics = await page.evaluate(() => {
        clearInterval(window.__calmTextStorm);
        return structuredClone(window.__calmTestMetrics);
      });
      assert.equal(metrics.fullDomScans, 0, 'text changes must not trigger whole-document shadow-root walks');
      assert.ok(metrics.videoScans <= 2, `media discovery must remain bounded during ticker updates: ${metrics.videoScans}`);
      assert.ok((metrics.messages.REPORT_STATUS || 0) <= 1, 'status telemetry must be throttled during ordinary playback');
      assert.equal(metrics.messages.GET_CONTEXT || 0, 0, 'playing pages must not poll their unchanged timing context');
    });

    await t.test('a different credit-tail duration does not block an otherwise valid automatic intro skip', async () => {
      await page.locator('video').evaluate(video => { video.pause(); video.src = '/fixture-media.wav?different=1'; video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2700), 'different release metadata');
      await seek(269.1);
      await until(async () => (await currentTime()) >= 302, 'intro skip despite differing credit tail');
      assert.ok(await currentTime() < 305, 'known intro ranges should not depend on exact total runtime');
    });

    await t.test('intro-only metadata skips automatically without an unrelated outro requirement', async () => {
      const introOnly = structuredClone(fixture);
      introOnly.recap = null; introOnly.outro = null;
      introOnly.no_recap = true; introOnly.no_outro = true;
      const imported = await message('IMPORT_TIMINGS', { data: introOnly });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      await page.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2700), 'intro-only media reload');
      await seek(269.1);
      await until(async () => (await currentTime()) >= 302, 'intro-only automatic skip');
      assert.ok(await currentTime() < 305);
      await message('IMPORT_TIMINGS', { data: fixture });
    });

    await t.test('scrubbing back into story cancels a pending credits advance', async () => {
      await page.locator('video').evaluate(video => { video.pause(); video.src = '/fixture-media.wav'; video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'original release metadata');
      await seek(2599.1);
      await page.locator('#thecalm-skip-overlay').locator('#cancel-next').waitFor({ state: 'visible' });
      await seek(110);
      await delay(3300);
      assert.equal(page.url(), EPISODE_URL, 'scrubbing to story must cancel pending next episode');
      const position = await currentTime();
      assert.ok(position >= 110 && position < 116, `story playback must continue: ${position}`);
      assert.equal(await page.locator('#thecalm-skip-overlay').locator('#cancel-next').isVisible(), false, 'cancelled countdown controls must be hidden');
    });

    await t.test('disabling only auto-next cancels a pending credits advance', async () => {
      await page.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'reloaded release metadata');
      await seek(2599.1);
      await page.locator('#thecalm-skip-overlay').locator('#cancel-next').waitFor({ state: 'visible' });
      const changed = await message('SET_SETTINGS', { settings: { autoNext: false } });
      assert.equal(changed.ok, true, JSON.stringify(changed));
      assert.equal(changed.settings.enabled, true, 'other automatic skipping stays enabled');
      await delay(3300);
      assert.equal(page.url(), EPISODE_URL, 'turning off auto-next must cancel pending navigation');
      assert.equal(await page.locator('#thecalm-skip-overlay').locator('#cancel-next').isVisible(), false, 'disabled countdown controls must be hidden');
      await message('SET_SETTINGS', { settings: { autoNext: true } });
    });

    await t.test('credits countdown can be cancelled and next episode follows an actual link', async () => {
      await page.locator('video').evaluate(video => { video.pause(); video.src = '/fixture-media.wav'; video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'original release metadata');
      await seek(2599.1);
      await page.locator('#thecalm-skip-overlay').locator('#cancel-next').click();
      await delay(3300);
      assert.equal(page.url(), EPISODE_URL, 'cancelled countdown must keep the episode');
      // Replacing the media creates a fresh playback session for another attempt.
      await page.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'reloaded media');
      await seek(2599.1);
      await page.waitForURL('**/season-1/episode-19', { timeout: 10000 });
      await until(async () => { const state = await message('GET_CONTEXT'); return state.context?.episode === 19 && !state.timings; }, 'cleared timing context');
      await seek(1); await delay(500);
      assert.ok(await currentTime() < 4, 'missing episode metadata must not auto skip');
    });

    await t.test('credits advance automatically when the stored credit tail extends beyond the video', async () => {
      await page.goto(EPISODE_URL);
      await message('IMPORT_TIMINGS', { data: fixture });
      await message('SET_SETTINGS', { settings: { enabled: true, autoNext: true } });
      await page.locator('video').evaluate(video => { video.pause(); video.src = '/fixture-media.wav?short-credits=1'; video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2600), 'shortened credit-tail media');
      await seek(2599.1);
      await until(() => page.locator('video').evaluate(video => video.ended), 'natural video end during the next-episode countdown');
      assert.equal(page.url(), EPISODE_URL, 'the natural ending occurs before the three-second countdown completes');
      await page.waitForURL('**/season-1/episode-19', { timeout: 10000 });
      assert.equal(new URL(page.url()).pathname, '/shows/prison-break/season-1/episode-19');
    });

    await t.test('automatic credits advance activates the site next-episode button without a viewer click', async () => {
      await page.goto(EPISODE_URL);
      await message('IMPORT_TIMINGS', { data: fixture });
      await message('SET_SETTINGS', { settings: { enabled: true, autoNext: true } });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'button-based episode media');
      await page.evaluate(() => {
        document.querySelector('#next-episode').remove();
        sessionStorage.setItem('fixture-next-clicks', '0');
        const next = document.createElement('button');
        next.type = 'button'; next.setAttribute('aria-label', 'Next episode');
        next.textContent = 'Play next episode';
        next.addEventListener('click', () => {
          sessionStorage.setItem('fixture-next-clicks', String(Number(sessionStorage.getItem('fixture-next-clicks')) + 1));
          location.assign('/shows/prison-break/season-1/episode-19');
        });
        document.body.append(next);
      });
      await seek(2599.1);
      await page.waitForURL('**/season-1/episode-19', { timeout: 10000 });
      assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-next-clicks')), '1', 'the actual site control must receive one programmatic click');
    });

    await t.test('credits automatically leave native video fullscreen before opening the next episode', async () => {
      await page.goto(EPISODE_URL);
      await message('IMPORT_TIMINGS', { data: fixture });
      await message('SET_SETTINGS', { settings: { enabled: true, autoNext: true } });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'fullscreen episode media');
      await page.evaluate(() => {
        // Managed headless Chromium cannot validate OS fullscreen presentation.
        // Control only the DOM fullscreen state while keeping real media/events.
        const video = document.querySelector('video');
        sessionStorage.setItem('fixture-fullscreen-exits', '0');
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => video });
        document.exitFullscreen = async () => {
          sessionStorage.setItem('fixture-fullscreen-exits', String(Number(sessionStorage.getItem('fixture-fullscreen-exits')) + 1));
          delete document.fullscreenElement;
        };
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      await seek(2599.1);
      await page.waitForURL('**/season-1/episode-19', { timeout: 10000 });
      assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-fullscreen-exits')), '1', 'navigation must exit native video fullscreen');
    });

    await t.test('credits do not invent a next episode when no episode control or link exists', async () => {
      await page.goto(EPISODE_URL);
      await message('IMPORT_TIMINGS', { data: fixture });
      await message('SET_SETTINGS', { settings: { enabled: true, autoNext: true } });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'finale-like episode media');
      await page.evaluate(() => {
        document.querySelectorAll('a[href]').forEach(link => link.remove());
        window.fixtureCarouselClicks = 0;
        const unrelated = document.createElement('button');
        unrelated.type = 'button'; unrelated.textContent = 'Next';
        unrelated.setAttribute('aria-label', 'Next carousel item');
        unrelated.addEventListener('click', () => window.fixtureCarouselClicks++);
        document.body.append(unrelated);
      });
      await seek(2599.1);
      await delay(4500);
      assert.equal(page.url(), EPISODE_URL, 'absence of a supported next episode must leave the current page intact');
      assert.equal(await page.evaluate(() => window.fixtureCarouselClicks), 0, 'an unrelated Next button must not be activated');
      assert.ok(await currentTime() >= 2599, 'credits should continue when no next episode can be identified');
    });

    await t.test('SPA episode metadata cannot control the old media source, even with identical durations', async () => {
      await page.evaluate(() => window.fixture.navigate(18));
      await until(async () => (await message('GET_CONTEXT')).context?.episode === 18, 'SPA return to cached episode');
      await page.locator('video').evaluate(video => { video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'episode 18 media reload');
      await until(async () => (await playerStatus()).safety.ok, 'episode 18 media binding');
      await seek(110);
      // A client-side URL update leaves episode 18's existing video playing.
      await page.evaluate(() => history.pushState({}, '', '/shows/prison-break/season-1/episode-19'));
      const episode19 = structuredClone(fixture);
      episode19.episode = 19;
      const imported = await message('IMPORT_TIMINGS', { data: episode19 });
      assert.equal(imported.ok, true, JSON.stringify(imported));
      await until(async () => {
        const response = await message('GET_CONTEXT');
        return response.context?.episode === 19 && response.timings?.episode === 19;
      }, 'valid same-duration episode 19 timings');
      await delay(400);
      const staleState = await playerStatus();
      assert.equal(staleState.safety.ok, false, 'matching duration must not approve an old episode media binding');
      assert.match(staleState.safety.reason, /episode.*player.*load/i);
      await seek(269.1); await delay(600);
      assert.ok(await currentTime() < 273, 'new metadata must not skip the old episode source');
      await page.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => page.locator('video').evaluate(video => video.duration === 2639), 'new episode source reload');
      await until(async () => (await playerStatus()).safety.ok, 'new episode media binding');
      await seek(269.1);
      await until(async () => (await currentTime()) >= 302, 'new source restored automatic skipping');
      assert.ok(await currentTime() < 305);
    });

    await t.test('embedded media requires a matching host grant and supports child-frame skipping', async () => {
      await page.evaluate(() => window.fixture.navigate(18));
      await message('IMPORT_TIMINGS', { data: fixture });
      await page.evaluate(() => {
        document.querySelector('video').remove();
        const iframe = document.createElement('iframe');
        iframe.id = 'movie-player';
        iframe.src = 'https://player.thecalm-fixture.test/embed';
        iframe.width = '720'; iframe.height = '480';
        const ad = document.createElement('iframe');
        ad.id = 'larger-ad-frame';
        ad.src = 'https://ads.thecalm-fixture.test/ad';
        ad.width = '1100'; ad.height = '700';
        document.body.append(iframe, ad);
      });
      await until(() => page.frames().some(frame => frame.url().startsWith('https://player.thecalm-fixture.test/')), 'embedded player frame');
      const child = page.frames().find(frame => frame.url().startsWith('https://player.thecalm-fixture.test/'));
      await until(() => child.locator('video').evaluate(video => video.duration === 2639), 'embedded real media');
      const origins = await message('PLAYER_ORIGINS');
      assert.equal(origins.ok, true, JSON.stringify(origins));
      assert.ok(origins.playerOrigins.some(item => item.origin === 'https://player.thecalm-fixture.test'), 'a larger unrelated iframe must not exclude the actual movie player');
      await seek(269.1, true, child); await delay(500);
      assert.ok(await currentTime(child) < 272, 'unconnected embed must remain untouched');
      const denied = await message('CONNECT_PLAYER', { origins: ['https://player.thecalm-fixture.test'] });
      assert.equal(denied.ok, false, 'actual host access must be granted first');
      const unrelated = await message('CONNECT_PLAYER', { origins: ['https://unrelated.example'] });
      assert.equal(unrelated.ok, false, 'arbitrary host requests must be rejected');
      permissions.add('https://player.thecalm-fixture.test/*');
      const connected = await message('CONNECT_PLAYER', { origins: ['https://player.thecalm-fixture.test'] });
      assert.equal(connected.ok, true, JSON.stringify(connected));
      assert.equal(connected.connectedFrames, 1);
      await until(async () => (await currentTime(child)) >= 302, 'embedded intro skip');
      assert.ok(await currentTime(child) < 306);
      const undone = await message('UNDO_SKIP');
      assert.equal(undone.ok, true, JSON.stringify(undone));
      await delay(400);
      assert.ok(await currentTime(child) < 275, 'top popup undo must reach child media');

      await child.evaluate(() => history.pushState({}, '', '/embed?stream=switched'));
      assert.equal(await page.locator('#movie-player').getAttribute('src'), 'https://player.thecalm-fixture.test/embed', 'the parent source attribute remains unchanged after child navigation');
      await child.locator('video').evaluate(video => { video.pause(); video.load(); });
      await until(() => child.locator('video').evaluate(video => video.duration === 2639), 'media after embedded URL update');
      await seek(269.1, true, child);
      await until(async () => (await currentTime(child)) >= 302, 'automatic skip after embedded player changes its own URL');
      assert.ok(await currentTime(child) < 306, 'verified parent/frame association must survive an internal player URL change');

      await child.locator('video').evaluate(video => video.pause());
      await page.locator('#movie-player').evaluate(iframe => { iframe.style.display = 'none'; });
      await delay(2000);
      await child.locator('video').evaluate(video => video.load());
      await until(() => child.locator('video').evaluate(video => video.duration === 2639), 'hidden embedded media reload');
      await seek(269.1, true, child); await delay(2200);
      assert.ok(await currentTime(child) < 275, 'a known frame association must not authorize a now-hidden parent iframe');
      await page.locator('#movie-player').evaluate(iframe => { iframe.style.display = ''; });
      await until(async () => (await currentTime(child)) >= 302, 'automatic skip recovers when the verified parent iframe becomes visible');

      // Slow bridge responses must recover rather than leaving a connected
      // player indefinitely inactive after its short active-player lease expires.
      embeddedReportDelay = 2200;
      try {
        await delay(1800); // Let the old short authorization lease expire first.
        await child.locator('video').evaluate(video => { video.pause(); video.load(); });
        await until(() => child.locator('video').evaluate(video => video.duration === 2639), 'embedded media reload with slow status reports');
        await seek(269.1, true, child);
        await until(async () => (await currentTime(child)) >= 302, 'automatic embedded skip after delayed status report', 12000);
        assert.ok(await currentTime(child) < 310);
      } finally {
        embeddedReportDelay = 0;
      }

      // Automatic seeks are authorized at the action boundary. Status messages
      // are only telemetry and must not be a prerequisite for valid playback.
      dropEmbeddedReports = true;
      try {
        await delay(1800);
        await child.locator('video').evaluate(video => { video.pause(); video.load(); });
        await until(() => child.locator('video').evaluate(video => video.duration === 2639), 'embedded media while status reports are dropped');
        await seek(269.1, true, child);
        await until(async () => (await currentTime(child)) >= 302, 'automatic skip independent of dropped status telemetry');
        assert.ok(await currentTime(child) < 307, 'a valid action must not wait for an expiring telemetry lease');
      } finally {
        dropEmbeddedReports = false;
      }
    });

    assert.deepEqual(errors, [], 'real browser pages should not report script errors');
  } finally {
    await context.close(); await browser.close();
    delete globalThis.chrome; delete globalThis.CalmPlayers;
  }
});
