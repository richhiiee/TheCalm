'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension');
const output = path.join(root, 'dist', 'thecalm-skip.zip');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.version) {
  throw new Error('The extension must contain a valid Manifest V3 manifest.');
}
function assertLocalResource(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid extension resource path: ${String(file)}`);
  }
  const resolved = path.resolve(source, file);
  if (!resolved.startsWith(source + path.sep) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Missing extension resource: ${file}`);
  }
}
const resources = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])
].filter(Boolean);
for (const file of resources) assertLocalResource(file);
for (const file of resources.filter(file => file.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(source, file), 'utf8');
  for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
    if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
    assertLocalResource(path.posix.join(path.posix.dirname(file), match[1]));
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const script = `
import pathlib, sys, zipfile
source, target = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(source.rglob('*')):
        if file.is_symlink():
            raise RuntimeError('Extension packaging refuses symlinks: ' + str(file))
        if not file.is_file() or file.name == '.DS_Store':
            continue
        entry = zipfile.ZipInfo(file.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
`;
const result = spawnSync('python3', ['-c', script, source, output], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Packaged ${manifest.name} ${manifest.version}: ${output}`);
