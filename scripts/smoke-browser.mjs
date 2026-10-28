import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(process.cwd(), 'browser-shots');
fs.mkdirSync(OUT, { recursive: true });

const fallback = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe');
const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync(fallback) ? fallback : undefined);

const errors = [];
const warnings = [];
const failed = [];
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.type() === 'warning') warnings.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
page.on('requestfailed', (req) => failed.push(`${req.url()} :: ${req.failure()?.errorText}`));

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  console.log('screenshot:', name);
};

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const startVisible = await page.locator('.start-screen').isVisible();
  console.log('start screen visible:', startVisible);
  await shot('01-start.png');

  await page.locator('.faction-card', { hasText: '大雍' }).click();
  await page.locator('.role-card', { hasText: '君主' }).click();
  await page.locator('.start-actions .btn.primary').click();
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  await page.waitForTimeout(4200);
  await shot('02-map.png');

  const canvasBox = await page.locator('.map-stage canvas').boundingBox();
  const dateText = await page.locator('.top-date .d').innerText();
  const regionLabels = await page.locator('.map-region-label').count();
  const armyLabels = await page.locator('.map-army-label').count();
  const flash = await page.locator('.toast').count();
  console.log('canvas:', canvasBox, 'date:', dateText, 'regionLabels:', regionLabels, 'armyLabels:', armyLabels, 'toast:', flash);

  await page.locator('.top-actions .btn', { hasText: '命令' }).click();
  await page.waitForSelector('.sheet', { timeout: 10_000 });
  await shot('03-orders.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.rail button[title="人物"]').click();
  await page.waitForSelector('.sheet .char-card', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  await shot('04-characters.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.rail button[title="兵种"]').click();
  await page.waitForSelector('.sheet .card', { timeout: 10_000 });
  await page.waitForTimeout(800);
  await shot('05-units.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.top-actions .btn.primary', { hasText: '结束本旬' }).click();
  await page.waitForTimeout(3500);
  const dateAfter = await page.locator('.top-date .d').innerText();
  console.log('date after turn:', dateAfter);
  await shot('06-turn.png');

  await page.locator('.rail button[title="存档"]').click();
  await page.waitForSelector('.sheet', { timeout: 10_000 });
  await page.locator('.sheet-main .btn.primary', { hasText: '保存' }).click();
  await page.waitForTimeout(1200);
  await shot('07-save.png');
  await page.locator('.sheet-head .close').click();

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  await page.waitForTimeout(3500);
  const dateReload = await page.locator('.top-date .d').innerText();
  console.log('date after reload:', dateReload);
  await shot('08-reload.png');
  console.log('persisted:', dateReload === dateAfter);
} catch (err) {
  console.error('SMOKE FAILED:', err.message);
  errors.push(`SMOKE: ${err.message}`);
  await shot('99-failure.png');
} finally {
  console.log('\n--- console errors ---');
  console.log(errors.length ? errors.slice(0, 30).join('\n') : '(none)');
  console.log('\n--- failed requests ---');
  console.log(failed.length ? failed.slice(0, 30).join('\n') : '(none)');
  console.log('\n--- warnings ---');
  console.log(warnings.length ? warnings.slice(0, 10).join('\n') : '(none)');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
}
