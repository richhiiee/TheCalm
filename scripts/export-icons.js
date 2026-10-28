'use strict';

// Export the approved artwork at browser/store sizes without changing its design.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const source = await fs.readFile(path.join(root, 'docs/store/assets/icon-source.png'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const exports = await page.evaluate(async base64 => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const result = {};
      for (const size of [16, 32, 48, 128, 512]) {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, size, size);
        result[size] = canvas.toDataURL('image/png').split(',')[1];
      }
      return result;
    }, source.toString('base64'));
    for (const [size, base64] of Object.entries(exports)) {
      const folder = Number(size) === 512 ? 'docs/store/assets' : 'extension/icons';
      await fs.writeFile(path.join(root, folder, `icon-${size}.png`), Buffer.from(base64, 'base64'));
    }
    await fs.copyFile(path.join(root, 'extension/icons/icon-128.png'), path.join(root, 'docs/store/assets/icon-128.png'));
    console.log('Exported CalmSkip toolbar, extension, and store PNG icons.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
