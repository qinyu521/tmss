import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'browser-shots');
fs.mkdirSync(OUT, { recursive: true });
const fallback = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? fallback, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name) }); console.log('shot', name); };

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.faction-card', { hasText: '大雍' }).click();
  await page.locator('.role-card', { hasText: '君主' }).click();
  await page.locator('.start-actions .btn.primary').click();
  await page.waitForSelector('.app-shell');
  await page.waitForTimeout(3000);
  await shot('11-map-garrison.png');

  await page.locator('.top-actions .btn', { hasText: '命令' }).click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(600);
  await shot('12-orders-military.png');

  // 分兵：默认第一支部队，调低到 10000，选择统兵官和目标
  await page.evaluate(() => {
    const range = document.querySelector('.sheet-main input[type="range"]');
    if (range) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, '10000');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  const selects = page.locator('.sheet-main select');
  console.log('select count', await selects.count());
  const commanderSelect = selects.nth(1);
  if ((await commanderSelect.locator('option').count()) > 1) await commanderSelect.selectOption({ index: 1 });
  const targetSelect = selects.nth(2);
  await targetSelect.selectOption('YONG-REG02');
  await page.waitForTimeout(400);
  console.log('submit disabled:', await page.locator('.btn.primary', { hasText: '下达此命令' }).isDisabled());
  await page.locator('.btn.primary', { hasText: '下达此命令' }).click();
  await page.waitForTimeout(1000);
  const resultText = await page.locator('.card .ok-text, .card .danger-text').allInnerTexts().catch(() => []);
  console.log('split result:', resultText);
  await shot('13-orders-split-result.png');

  // 计谋 tab
  await page.locator('.sheet-tabs button', { hasText: '计谋' }).click();
  await page.waitForTimeout(500);
  await shot('14-orders-scheme.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.rail button[title="朝议"]').click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(500);
  await shot('15-court.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.rail button[title="军队"]').click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(500);
  await shot('16-army.png');
  await page.locator('.sheet-head .close').click();

  await page.locator('.top-actions .btn.primary', { hasText: '结束本旬' }).click();
  await page.waitForTimeout(3500);
  await shot('17-turn-after-split.png');
  console.log('errors:', errors.length ? errors : 'none');
} catch (err) {
  console.error('FAILED', err.message);
  await shot('19-failure.png');
  console.log('errors:', errors);
} finally {
  await browser.close();
}
