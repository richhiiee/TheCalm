'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const SCRIPT = path.resolve(__dirname, '../scripts/sync-dev.ps1');
const POWERSHELL = process.env.CALM_SKIP_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const IDENTITY = ['-c', 'user.name=Sync Test', '-c', 'user.email=sync-test@example.invalid', '-c', 'commit.gpgsign=false'];

before(() => {
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(result.status, 0, 'PowerShell is required for this suite. Set CALM_SKIP_PWSH to its executable. ' + (result.error?.message || result.stderr || ''));
});

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'thecalm sync tests '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source checkout with spaces');
  const extension = path.join(source, 'extension');
  const install = path.join(root, 'installed extension');
  await writeExtension(extension);
  return { root, source, extension, install };
}

async function writeExtension(directory) {
  await fs.mkdir(directory, { recursive: true });
  const manifest = {
    manifest_version: 3, name: 'TheCalm Skip', version: '0.1.3',
    background: { service_worker: 'worker.js' },
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['https://thecalm.site/*'], js: ['content.js'] }]
  };
  await Promise.all([
    fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2)),
    fs.writeFile(path.join(directory, 'worker.js'), '// initial worker\n'),
    fs.writeFile(path.join(directory, 'content.js'), '// initial content\n'),
    fs.writeFile(path.join(directory, 'popup.html'), '<!doctype html><link rel="stylesheet" href="popup.css"><script src="popup.js" defer></script>'),
    fs.writeFile(path.join(directory, 'popup.js'), '// initial popup\n'),
    fs.writeFile(path.join(directory, 'popup.css'), 'body { color: teal; }\n')
  ]);
}

function sync(h, extra = [], expectedStatus = 0) {
  const result = spawnSync(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT,
    '-SourceDirectory', h.source, '-InstallDirectory', h.install, ...extra
  ], { encoding: 'utf8', timeout: 30000 });
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, expectedStatus, 'Unexpected sync exit status.\n' + output + (result.error?.message || ''));
  return output;
}

async function filesUnder(directory) {
  const found = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return found; throw error; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else found.push(full);
  }
  return found.sort();
}

async function snapshot(directory) {
  const snapshot = {};
  for (const file of await filesUnder(directory)) snapshot[path.relative(directory, file)] = await fs.readFile(file, 'utf8');
  return snapshot;
}

function stateDirectory(h) {
  return path.join(path.dirname(h.install), path.basename(h.install) + '-dev-sync');
}

async function watch(h, t) {
  const child = spawn(POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT,
    '-SourceDirectory', h.source, '-InstallDirectory', h.install,
    '-Watch', '-Pull', '-PollSeconds', '1', '-PullIntervalSeconds', '15'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ error }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    child,
    output: () => output,
    async until(pattern) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (pattern.test(output)) return;
        assert.equal(child.exitCode, null, 'Watcher exited unexpectedly.\n' + output);
        await delay(50);
      }
      throw new Error('Watcher did not reach expected state: ' + pattern + '\n' + output);
    }
  };
}

async function backupContents(h, name) {
  const files = await filesUnder(path.join(stateDirectory(h), 'backups'));
  return Promise.all(files.filter(file => path.basename(file) === name).map(file => fs.readFile(file, 'utf8')));
}

async function commit(directory, message) {
  git(directory, ['add', '--all']);
  git(directory, [...IDENTITY, 'commit', '--quiet', '-m', message]);
}

async function gitFixture(t) {
  const h = await fixture(t);
  const origin = path.join(h.root, 'bare remote.git');
  const writer = h.source;
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=development', origin], { stdio: 'pipe' });
  git(writer, ['init', '--quiet', '--initial-branch=development']);
  git(writer, ['config', 'core.autocrlf', 'false']);
  await commit(writer, 'Initial extension');
  git(writer, ['remote', 'add', 'origin', origin]);
  git(writer, ['push', '--quiet', '--set-upstream', 'origin', 'development']);
  const clone = path.join(h.root, 'local development checkout');
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', origin, clone], { stdio: 'pipe' });
  git(clone, ['config', 'core.autocrlf', 'false']);
  return { ...h, writer, origin, source: clone, extension: path.join(clone, 'extension') };
}

test('initial sync copies validated extension resources and is idempotent', async t => {
  const h = await fixture(t);
  assert.match(sync(h), /Updated TheCalm Skip 0\.1\.3/);
  assert.deepEqual(await snapshot(h.install), await snapshot(h.extension));
  const firstState = await snapshot(stateDirectory(h));
  const output = sync(h);
  assert.match(output, /already up to date/i);
  assert.deepEqual(await snapshot(stateDirectory(h)), firstState, 'unchanged sync must not create backups or rewrite state');
});

test('updates back up replaced managed files and preserve unknown installed files', async t => {
  const h = await fixture(t);
  sync(h);
  await fs.writeFile(path.join(h.install, 'worker.js'), '// local installed modification\n');
  await fs.writeFile(path.join(h.install, 'my-notes.txt'), 'keep this local file\n');
  await fs.writeFile(path.join(h.extension, 'worker.js'), '// new upstream worker\n');
  sync(h);
  assert.equal(await fs.readFile(path.join(h.install, 'worker.js'), 'utf8'), '// new upstream worker\n');
  assert.equal(await fs.readFile(path.join(h.install, 'my-notes.txt'), 'utf8'), 'keep this local file\n');
  assert.deepEqual(await backupContents(h, 'worker.js'), ['// local installed modification\n']);
  // Windows PowerShell 5.1 writes a UTF-8 BOM for Set-Content -Encoding UTF8.
  const state = JSON.parse((await fs.readFile(path.join(stateDirectory(h), 'state.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(state.managed_files.some(file => file.path === 'my-notes.txt'), false, 'unknown files must not become managed');
});

test('retired unchanged resources are backed up while modified retired resources remain', async t => {
  const h = await fixture(t);
  await fs.writeFile(path.join(h.extension, 'retired.js'), '// retired original\n');
  await fs.writeFile(path.join(h.extension, 'retired-local.js'), '// original before local edit\n');
  sync(h);
  await fs.rm(path.join(h.extension, 'retired.js'));
  await fs.rm(path.join(h.extension, 'retired-local.js'));
  await fs.writeFile(path.join(h.install, 'retired-local.js'), '// keep local edit\n');
  const output = sync(h);
  await assert.rejects(fs.access(path.join(h.install, 'retired.js')), { code: 'ENOENT' });
  assert.deepEqual(await backupContents(h, 'retired.js'), ['// retired original\n']);
  assert.equal(await fs.readFile(path.join(h.install, 'retired-local.js'), 'utf8'), '// keep local edit\n');
  assert.match(output, /Preserved modified retired resource/);
});

test('invalid manifests and missing resources fail before changing the installation', async t => {
  const h = await fixture(t);
  sync(h);
  const expected = await snapshot(h.install);
  const originalManifest = await fs.readFile(path.join(h.extension, 'manifest.json'), 'utf8');
  await fs.writeFile(path.join(h.extension, 'manifest.json'), '{ broken json');
  assert.match(sync(h, [], 1), /manifest is not valid JSON/i);
  assert.deepEqual(await snapshot(h.install), expected);
  await fs.writeFile(path.join(h.extension, 'manifest.json'), originalManifest);
  await fs.rm(path.join(h.extension, 'popup.js'));
  assert.match(sync(h, [], 1), /Missing extension resource: popup\.js/);
  assert.deepEqual(await snapshot(h.install), expected);
});

test('a different installed extension is never overwritten', async t => {
  const h = await fixture(t);
  await fs.mkdir(h.install);
  await fs.writeFile(path.join(h.install, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Another extension', version: '1' }));
  const original = await snapshot(h.install);
  assert.match(sync(h, [], 1), /different installed extension/);
  assert.deepEqual(await snapshot(h.install), original);
});

test('overlapping source and target folders are rejected', async t => {
  const h = await fixture(t);
  const nested = { ...h, install: path.join(h.source, 'nested install') };
  assert.match(sync(nested, [], 1), /non-overlapping/);
  await assert.rejects(fs.access(nested.install), { code: 'ENOENT' });
  const enclosing = { ...h, install: h.root };
  assert.match(sync(enclosing, [], 1), /non-overlapping/);
});

test('symbolic links and junctions cannot escape the managed source or target', async t => {
  const h = await fixture(t);
  const outside = path.join(h.root, 'outside folder');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'must not be copied\n');
  const linked = path.join(h.extension, 'linked assets');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(sync(h, [], 1), /symbolic link|junction/i);
  await assert.rejects(fs.access(h.install), { code: 'ENOENT' });
  await fs.rm(linked);
  sync(h);
  const expected = await snapshot(h.install);
  await fs.symlink(outside, path.join(h.install, 'linked target'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(sync(h, [], 1), /symbolic link|junction/i);
  assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'must not be copied\n');
  await fs.rm(path.join(h.install, 'linked target'));
  assert.deepEqual(await snapshot(h.install), expected);
});

test('a file-versus-directory collision is rejected before any partial update', async t => {
  const h = await fixture(t);
  sync(h);
  await fs.rm(path.join(h.install, 'worker.js'));
  await fs.mkdir(path.join(h.install, 'worker.js'));
  await fs.writeFile(path.join(h.install, 'worker.js', 'local.txt'), 'keep directory\n');
  const expected = await snapshot(h.install);
  await fs.writeFile(path.join(h.extension, 'content.js'), '// changed content\n');
  assert.match(sync(h, [], 1), /directory conflicts with a managed extension file/i);
  assert.deepEqual(await snapshot(h.install), expected);
});

test('rollback continues after one restoration fails and reports the preserved backup', async t => {
  const h = await fixture(t);
  sync(h);
  await fs.writeFile(path.join(h.extension, 'content.js'), '// new content needing manual recovery\n');
  await fs.writeFile(path.join(h.extension, 'popup.js'), '// new popup that must roll back\n');
  await fs.writeFile(path.join(h.extension, 'worker.js'), '// new worker triggering a failed write\n');
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  // Inject filesystem faults at the Copy-Item boundary in an isolated process;
  // production validation, staging, backup, copy and rollback code still runs.
  const command = '& { function global:Copy-Item { ' +
    '[CmdletBinding()] param([string] $LiteralPath, [string] $Destination, [switch] $Force) ' +
    '$leaf = [IO.Path]::GetFileName($Destination); ' +
    'if ($Destination.StartsWith($env:CALM_SKIP_TEST_INSTALL + [IO.Path]::DirectorySeparatorChar)) { ' +
    'if ($leaf -eq "worker.js" -and $LiteralPath -match "stage-") { throw "Simulated deployment write failure" } ' +
    'if ($leaf -eq "content.js" -and $LiteralPath -match "[\\\\/]backups[\\\\/]") { throw "Simulated restore failure" } ' +
    '} Microsoft.PowerShell.Management\\Copy-Item @PSBoundParameters }; ' +
    '& ' + quote(SCRIPT) + ' -SourceDirectory ' + quote(h.source) + ' -InstallDirectory ' + quote(h.install) + ' }';
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CALM_SKIP_TEST_INSTALL: h.install }
  });
  assert.equal(result.status, 1, (result.stdout || '') + (result.stderr || ''));
  assert.equal(await fs.readFile(path.join(h.install, 'popup.js'), 'utf8'), '// initial popup\n', 'later rollback entries must still be restored');
  assert.equal(await fs.readFile(path.join(h.install, 'worker.js'), 'utf8'), '// initial worker\n');
  assert.equal(await fs.readFile(path.join(h.install, 'content.js'), 'utf8'), '// new content needing manual recovery\n');
  assert.deepEqual(await backupContents(h, 'content.js'), ['// initial content\n'], 'the failed restore must retain its recovery copy');
  assert.match((result.stdout || '') + (result.stderr || ''), /content\.js/);
  assert.match((result.stdout || '') + (result.stderr || ''), /backup/i);
});

test('-Pull refuses local changes without changing checkout or installed files', async t => {
  const h = await gitFixture(t);
  sync(h, ['-Pull']);
  const installed = await snapshot(h.install);
  const head = git(h.source, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(h.extension, 'worker.js'), '// uncommitted local edits\n');
  await fs.writeFile(path.join(h.writer, 'extension', 'worker.js'), '// upstream update\n');
  await commit(h.writer, 'Upstream update');
  git(h.writer, ['push', '--quiet']);
  assert.match(sync(h, ['-Pull'], 1), /local changes/);
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), head);
  assert.equal(await fs.readFile(path.join(h.extension, 'worker.js'), 'utf8'), '// uncommitted local edits\n');
  assert.deepEqual(await snapshot(h.install), installed);
});

test('-Pull fast-forwards the existing branch and deploys its validated update', async t => {
  const h = await gitFixture(t);
  sync(h, ['-Pull']);
  await fs.writeFile(path.join(h.writer, 'extension', 'worker.js'), '// fast-forwarded worker\n');
  await commit(h.writer, 'New worker');
  git(h.writer, ['push', '--quiet']);
  sync(h, ['-Pull']);
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), git(h.writer, ['rev-parse', 'HEAD']));
  assert.equal(await fs.readFile(path.join(h.install, 'worker.js'), 'utf8'), '// fast-forwarded worker\n');
  assert.deepEqual(await backupContents(h, 'worker.js'), ['// initial worker\n']);
  assert.equal(git(h.source, ['status', '--porcelain']), '', 'updater must leave its checkout clean');
});

test('-Pull refuses divergent history rather than resetting or overwriting installed files', async t => {
  const h = await gitFixture(t);
  sync(h, ['-Pull']);
  const installed = await snapshot(h.install);
  await fs.writeFile(path.join(h.extension, 'worker.js'), '// local committed worker\n');
  await commit(h.source, 'Local development commit');
  const localHead = git(h.source, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(h.writer, 'extension', 'worker.js'), '// separate upstream worker\n');
  await commit(h.writer, 'Divergent upstream commit');
  git(h.writer, ['push', '--quiet']);
  assert.match(sync(h, ['-Pull'], 1), /Git 'merge' failed|fast-forward/i);
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), localHead);
  assert.equal(await fs.readFile(path.join(h.extension, 'worker.js'), 'utf8'), '// local committed worker\n');
  assert.deepEqual(await snapshot(h.install), installed);
});

test('-Watch -Pull preserves local edits created between upstream polls', { timeout: 20000 }, async t => {
  const h = await gitFixture(t);
  sync(h, ['-Pull']);
  const installed = await snapshot(h.install);
  const running = await watch(h, t);
  await running.until(/already up to date/i);
  await fs.writeFile(path.join(h.extension, 'worker.js'), '// local edit while watcher runs\n');
  await running.until(/local edits|source checkout changed|source checkout has local changes/i);
  await delay(1300);
  assert.deepEqual(await snapshot(h.install), installed, 'dirty source must not deploy between scheduled pulls');
  assert.equal(await fs.readFile(path.join(h.extension, 'worker.js'), 'utf8'), '// local edit while watcher runs\n');
});

test('-Watch -Pull never deploys local files after an unsuccessful initial fetch', { timeout: 20000 }, async t => {
  const h = await gitFixture(t);
  git(h.source, ['remote', 'set-url', 'origin', path.join(h.root, 'missing remote.git')]);
  const running = await watch(h, t);
  await running.until(/Git 'fetch' failed|does not appear to be a git repository/i);
  await delay(2300);
  await assert.rejects(fs.access(h.install), { code: 'ENOENT' });
  assert.equal(git(h.source, ['status', '--porcelain']), '', 'failed fetch must not alter the local checkout');
});
