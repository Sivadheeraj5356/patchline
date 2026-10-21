import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const v1 = readFileSync('fixtures/openapi/payments-v1.json', 'utf8');
const v2 = readFileSync('fixtures/openapi/payments-v2.yaml', 'utf8');
let current = v1;
const fixture = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(current); });
await new Promise((r) => fixture.listen(18901, r));

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8484/', { waitUntil: 'networkidle0' });
await page.click('#watchTab');
await page.type('#wName', 'Acme Payments');
await page.type('#wUrl', 'http://localhost:18901/openapi.json');
await page.type('#wInt', '60');
await page.click('#addWatch');
await new Promise((r) => setTimeout(r, 1500));
const rowText = await page.evaluate(() => document.querySelector('#watchTable tbody')?.innerText);
console.log('WATCH ROW:', JSON.stringify(rowText));

// swap the served spec and click Check now
current = v2;
await page.click('[data-check]');
await new Promise((r) => setTimeout(r, 2000));
const eventText = await page.evaluate(() => document.querySelector('#eventList')?.innerText);
console.log('EVENT:', JSON.stringify(eventText).slice(0, 300));
await page.screenshot({ path: '/tmp/ui-5-watch-live.png', fullPage: true });
console.log('ERRORS:', errors.join(' | ') || 'none');
await browser.close();
fixture.close();
