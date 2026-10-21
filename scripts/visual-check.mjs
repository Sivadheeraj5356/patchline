import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('http://localhost:8484/', { waitUntil: 'networkidle0' });
await page.screenshot({ path: '/tmp/ui-1-specs.png' });

// run the sample diff (server-normalized path)
await page.click('#runDiff');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: '/tmp/ui-2-diff.png', fullPage: true });

await page.click('#toImpact');
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: '/tmp/ui-3-impact.png', fullPage: true });

await page.click('#toPR');
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: '/tmp/ui-4-pr.png' });

// watch tab
await page.click('#watchTab');
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: '/tmp/ui-5-watch.png', fullPage: true });

// stats sanity
const stats = await page.evaluate(() => document.querySelector('#statRow')?.innerText);
console.log('STATS:', JSON.stringify(stats));
console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
