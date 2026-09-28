// 由專案根目錄的 icon.png 產生各種尺寸的圖示（沒有 icon.png 時用暫時的預設圖示）。
// 執行：NODE_PATH=$(npm root -g) node scripts/make-icons.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');

const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f39a64"/><stop offset="1" stop-color="#e2672d"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path fill="#fff" d="M256 316a52 52 0 0 0 52-52V160a52 52 0 0 0-104 0v104a52 52 0 0 0 52 52Zm86-52a86 86 0 0 1-172 0h-34a120 120 0 0 0 103 118.8V420h34v-37.2A120 120 0 0 0 376 264h-34Z"/>
</svg>`)}`;

const src = existsSync('icon.png')
  ? `data:image/png;base64,${readFileSync('icon.png').toString('base64')}`
  : PLACEHOLDER;
console.log(existsSync('icon.png') ? '使用 icon.png' : '找不到 icon.png，使用預設圖示');

const targets = [
  { file: 'public/icons/icon-192.png', size: 192, pad: 0, bg: 'transparent' },
  { file: 'public/icons/icon-512.png', size: 512, pad: 0, bg: 'transparent' },
  { file: 'public/icons/apple-touch-icon.png', size: 180, pad: 0, bg: '#ffffff' },
  { file: 'public/icons/icon-maskable-512.png', size: 512, pad: 0.12, bg: '#ffffff' },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - t.pad * 2));
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;width:${t.size}px;height:${t.size}px;display:grid;place-items:center;background:${t.bg}">
    <img src="${src}" style="width:${inner}px;height:${inner}px;object-fit:contain"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  writeFileSync(t.file, await page.screenshot({ omitBackground: t.bg === 'transparent' }));
  console.log('✓', t.file);
}
await browser.close();
