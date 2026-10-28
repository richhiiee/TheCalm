'use strict';

// Store screenshots use the shipped UI and controller with seekable synthetic
// media. They do not contain show footage or claim to be an authenticated site
// capture. Chrome transport and the IntroDB HTTP response are simulated here,
// as in the browser regression suite; background decisions remain production code.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { createBackgroundRuntime } = require('../extension/background.js');
const fixture = require('../tests/fixtures/prison-break-s01e21.json');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension');
const OUTPUT = path.join(ROOT, 'docs/store/assets');
const EPISODE = 'https://thecalm.site/shows/prison-break/season-1/episode-21?pl=0';
const POPUP = 'https://extension.calmskip.test/popup.html';
const ID = 'calmskip-store-demonstration';

function silentMedia(duration = 2656) {
  const sampleRate = 8000;
  const size = duration * sampleRate;
  const wav = Buffer.alloc(44 + size, 128);
  wav.write('RIFF'); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36);
  wav.writeUInt32LE(size, 40);
  return wav;
}

function presentation() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CalmSkip demonstration</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"TVEpisode","episodeNumber":21,"partOfSeries":{"@type":"TVSeries","sameAs":"https://www.imdb.com/title/tt0455275/"}}</script>
  <style>
    *{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;background:#0b191d;color:#f1faf6;font:16px/1.5 Arial,sans-serif}
    body:before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 36% 45%,#19443f88,transparent 70%);pointer-events:none}
    .brand{position:absolute;left:56px;top:35px;display:flex;align-items:center;gap:8px;font-size:21px;font-weight:700;letter-spacing:-.6px}.brand img{width:45px;height:45px}.pill{margin-left:13px;padding:5px 10px;border:1px solid #31514d;border-radius:20px;font:11px Arial,sans-serif;color:#b3d3c8;letter-spacing:.2px}
    h1{position:absolute;left:56px;top:119px;margin:0;font-size:55px;line-height:1.09;letter-spacing:-2.5px;font-weight:700}h1 span{color:#92e4cd}
    .description{position:absolute;left:58px;top:249px;width:720px;margin:0;color:#b1c9c1;font-size:18px;line-height:1.6}
    .player{position:absolute;left:56px;top:324px;width:800px;height:404px;border:1px solid #35524b;border-radius:18px;overflow:hidden;background:#061113;box-shadow:0 20px 60px #0004}
    video{position:absolute;inset:0;width:100%;height:100%;background:#081417}
    .synthetic-scene{position:absolute;inset:0 0 46px;display:grid;place-items:center;pointer-events:none;background:linear-gradient(135deg,#123b3c,#0a2229 65%,#143c32)}
    .synthetic-scene:before{content:"";position:absolute;width:580px;height:580px;border:1px solid #72c5ad22;border-radius:50%;transform:translate(200px,100px);box-shadow:0 0 0 65px #82cbb809,0 0 0 130px #82cbb805}
    .scene-label{z-index:1;text-align:center}.scene-label strong{display:block;font-size:24px;letter-spacing:-.5px;color:#c1dbd1}.scene-label small{display:block;margin-top:7px;font-size:13px;color:#8eafa2}
    .sample-label{position:absolute;left:22px;top:18px;font-size:11px;color:#a6c8ba;letter-spacing:1.7px;text-transform:uppercase}
    .popup-shell{position:absolute;left:904px;top:28px;width:360px;height:830px;transform:scale(.89);transform-origin:top left;border:1px solid #3e5a55;border-radius:18px;overflow:hidden;box-shadow:0 16px 70px #0008;background:#0c1520}
    iframe{border:0;width:360px;height:830px;display:block}.footnote{position:absolute;left:58px;top:753px;margin:0;color:#829f93;font-size:12px}.next{display:none}
  </style></head><body>
  <div class="brand"><img src="/assets/icon-128.png" alt="">CalmSkip <span class="pill">For thecalm.site</span></div>
  <h1 id="headline">Skip the recap.<br><span>Keep the story.</span></h1>
  <p id="description" class="description">Automatic intro and recap skips, with a brief confirmation<br>and an Undo button when you want to go back.</p>
  <div class="player"><video id="episode-video" controls muted preload="metadata" src="/synthetic-media.wav"></video><div class="synthetic-scene"><div class="sample-label">Demonstration player</div><div class="scene-label"><strong>More story. Less waiting.</strong><small>Synthetic media · no show footage</small></div></div></div>
  <a class="next" rel="next" href="/shows/prison-break/season-1/episode-22?pl=0">Next episode</a>
  <div class="popup-shell"><iframe id="popup-preview" src="${POPUP}" title="Actual CalmSkip extension popup"></iframe></div>
  <p class="footnote">Actual extension UI on a demonstration player. Community timestamps by IntroDB; episode coverage varies.</p>
  </body></html>`;
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
  const shared = await fs.readFile(path.join(EXTENSION, 'shared.js'), 'utf8');
  const content = await fs.readFile(path.join(EXTENSION, 'content.js'), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  let page;
  const data = {};
  const noopEvent = { addListener() {} };
  const chromeApi = {
    runtime: { id: ID, getURL: file => 'chrome-extension://' + ID + '/' + file, onMessage: noopEvent },
    storage: { local: {
      async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
      async set(values) { Object.assign(data, structuredClone(values)); }
    } },
    tabs: {
      async get() { return { id: 1, url: page.url() }; }, async query() { return [{ id: 1, url: page.url() }]; },
      async sendMessage(_id, message, options = {}) { return page.mainFrame().evaluate(message => globalThis.__calmDeliver(message), message); },
      onRemoved: noopEvent, onUpdated: noopEvent,
    },
    permissions: { async contains() { return false; } },
  };
  globalThis.CalmPlayers = { trackTab() {}, reconnectTab() {}, async handleMessage() { return { ok: true, connectedFrames: 0, playerOrigins: [] }; } };
  const runtime = createBackgroundRuntime(chromeApi, async url => Number(new URL(url).searchParams.get('episode')) === 21 ? new Response(JSON.stringify(fixture)) : new Response('', { status: 404 }));
  const popupSender = { id: ID, url: chromeApi.runtime.getURL('popup.html') };
  const shim = `(() => {
    const listeners = [];
    globalThis.chrome = {
      runtime: {id:${JSON.stringify(ID)}, getManifest:()=>(${JSON.stringify(manifest)}), getURL:file=>'chrome-extension://${ID}/'+file, sendMessage:message=>globalThis.__calmBridge(message), onMessage:{addListener:listener=>listeners.push(listener)}},
      tabs:{query:()=>globalThis.__calmBridge({type:'__QUERY'}),sendMessage:(tabId,message,options)=>globalThis.__calmBridge({type:'__TAB_MESSAGE',tabId,message,options})},
      permissions:{request:async()=>false,contains:async()=>false}
    };
    globalThis.__calmDeliver = message => new Promise(resolve => {
      let responded = false, asynchronous = false;
      const respond = value => {if(!responded){responded=true;resolve(value);}};
      for(const listener of listeners)if(listener(message,{id:${JSON.stringify(ID)}},respond)===true)asynchronous=true;
      if(!responded&&!asynchronous)resolve(undefined);
    });
  })();`;
  try {
    const wav = silentMedia();
    await context.route('https://thecalm.site/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/icon-128.png') return route.fulfill({ contentType: 'image/png', body: await fs.readFile(path.join(EXTENSION, 'icons/icon-128.png')) });
      if (url.pathname === '/synthetic-media.wav') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        return route.fulfill({ status: range ? 206 : 200, headers: { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) }, body: wav.subarray(start, end + 1) });
      }
      return route.fulfill({ contentType: 'text/html', body: presentation() });
    });
    await context.route('https://extension.calmskip.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (!/^(?:popup\.(?:html|css|js)|icons\/icon-\d+\.png)$/.test(name)) return route.abort();
      return route.fulfill({ contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'application/javascript', body: await fs.readFile(path.join(EXTENSION, name)) });
    });
    await context.exposeBinding('__calmBridge', async (source, request) => {
      if (request.type === '__QUERY') return [{ id: 1, url: page.url() }];
      if (request.type === '__TAB_MESSAGE') return chromeApi.tabs.sendMessage(request.tabId, request.message, request.options);
      const sender = source.frame.url().startsWith('https://extension.calmskip.test/') ? popupSender : { id: ID, url: source.frame.url(), frameId: 0, tab: { id: 1, url: page.url() } };
      return runtime.dispatch(request, sender);
    });
    await context.addInitScript({ content: shim + `\nif(location.hostname==='thecalm.site')document.addEventListener('DOMContentLoaded',()=>{\n${shared}\n${content}\n},{once:true});` });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(EPISODE);
    if (errors.length) throw new Error(errors.join('\n'));
    await page.waitForFunction(() => document.querySelector('video').duration === 2656);
    await page.waitForFunction(async () => (await globalThis.__calmDeliver({ type: 'GET_PLAYER_STATUS' }))?.player?.safety?.ok, undefined, { polling: 100 });
    await page.locator('#popup-preview').evaluate(iframe => { iframe.src = iframe.src; });
    const popup = page.frameLocator('#popup-preview');
    await popup.locator('#player-title').filter({ hasText: 'Player ready' }).waitFor();
    await page.locator('video').evaluate(async video => { video.currentTime = 0.1; await video.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 85);
    await page.locator('video').evaluate(video => video.pause());
    // Reload the shipped popup so its Undo button and playback snapshot reflect
    // the actual skip that just occurred, rather than a fabricated UI state.
    await page.locator('#popup-preview').evaluate(iframe => { iframe.src = iframe.src; });
    await popup.locator('#undo:not([disabled])').waitFor();
    await page.locator('#thecalm-skip-overlay').locator('p').filter({ hasText: 'Skipped recap' }).waitFor();
    await page.screenshot({ path: path.join(OUTPUT, 'screenshot-01-automatic-skip.png') });

    await page.evaluate(() => {
      document.querySelector('#headline').innerHTML = 'Your next episode,<br><span>automatically.</span>';
      document.querySelector('#description').innerHTML = 'Move on when the credits begin.<br>A short countdown gives you a moment to cancel.';
    });
    await page.locator('video').evaluate(async video => { video.currentTime = 2577.1; await video.play(); });
    await page.locator('#thecalm-skip-overlay').locator('#cancel-next').waitFor();
    await page.locator('#popup-preview').evaluate(iframe => { iframe.src = iframe.src; });
    await popup.locator('#player-time').filter({ hasText: '42:57' }).waitFor();
    await page.screenshot({ path: path.join(OUTPUT, 'screenshot-02-next-episode.png') });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Created two 1280 × 800 screenshots of the production UI in docs/store/assets.');
  } finally { await context.close(); await browser.close(); delete globalThis.CalmPlayers; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
