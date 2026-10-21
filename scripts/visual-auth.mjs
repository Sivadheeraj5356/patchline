// Visual proof of the auth gate: locked server shows the unlock overlay on
// 401, wrong key shows the error, correct key loads watches.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// 1. locked server: open watch tab -> 401 -> overlay
await page.goto('http://localhost:8485/', { waitUntil: 'networkidle0' });
await page.click('#watchTab');
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: '/tmp/auth-1-overlay.png' });

// 2. wrong key -> inline error
await page.type('#unlockKey', 'wrong-key');
await page.click('#unlockGo');
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: '/tmp/auth-2-wrong.png' });
const errVisible = await page.$eval('#unlockError', (el) => getComputedStyle(el).display !== 'none');

// 3. correct key -> overlay closes, watches list loads
await page.$eval('#unlockKey', (el) => (el.value = ''));
await page.type('#unlockKey', 'visual-test-key');
await page.click('#unlockGo');
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: '/tmp/auth-3-unlocked.png', fullPage: true });
const overlayGone = await page.$eval('#unlockOverlay', (el) => getComputedStyle(el).display === 'none');
const watchText = await page.$eval('#watchList', (el) => el.textContent).catch(() => '');

console.log(JSON.stringify({ errVisible, overlayGone, watchText: watchText.slice(0, 80), errors }, null, 1));
await browser.close();
