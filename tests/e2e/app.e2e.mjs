// End-to-end check of the app against the real Apps Script backend (Code.gs in a VM).
// Two browser contexts play two devices; requests to script.google.com are answered by the VM.
// Saves screenshots to docs/screenshots/. Run: npm run e2e  (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';
import { makeEnv, fakeMessage } from '../fake-gas.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));

const ROOT = new URL('../../', import.meta.url).pathname;
const SHOTS = join(ROOT, 'docs/screenshots');
mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
  res.end(readFileSync(path));
}).listen(0);
const APP = `http://localhost:${server.address().port}/`;

// ---------- backend ----------
const TOKEN = 'e2etoken0123456789abcdef01234567';
const EXEC = 'https://script.google.com/macros/s/AKfycbE2E/exec';
const LINK = `${EXEC}?token=${TOKEN}`;
const gas = makeEnv({ props: { TOKEN, ALLOWED_SENDERS: 'me@example.com' }, sheet: false });
gas.deliver = (msg) => gas.messages.push(msg);
gas.ctx.setup();

let offline = false;
async function routeBackend(context) {
  await context.route('https://script.google.com/**', async (route) => {
    if (offline) return route.abort('internetdisconnected');
    const req = route.request();
    const u = new URL(req.url());
    const parameter = Object.fromEntries(u.searchParams);
    const out = req.method() === 'POST'
      ? gas.ctx.doPost({ parameter, postData: { contents: req.postData() || '', type: 'text/plain' } })
      : gas.ctx.doGet({ parameter });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out.body });
  });
}

// ---------- seed data: "today" is the machine's date ----------
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const now = Date.now();
const seed = [
  { id: 's1', code: '3SCBLU123456789', carrier: 'postnl', title: 'Coolblue', subject: 'Sony WH-1000XM6 headphones', retailer: 'Coolblue', eta: day(0), etaWindow: '14:00–16:00', postcode: '5612AB', status: 'out', source: 'email' },
  { id: 's2', code: 'JVGL06240512345678901', carrier: 'dhl', title: 'bol.com', subject: 'Philips Hue starter kit', retailer: 'bol.com', eta: day(2), status: 'shipped', source: 'email' },
  { id: 's3', code: '05212345678901', carrier: 'dpd', title: 'Zalando', subject: 'Running shoes', retailer: 'Zalando', eta: day(5), status: 'shipped', source: 'email' },
  { id: 's4', code: 'LP00123456789012', carrier: 'cainiao', title: 'AliExpress', subject: 'USB-C cables (3×)', retailer: 'AliExpress', status: 'shipped', source: 'paste' },
  { id: 's5', code: '1Z999AA10123456784', carrier: 'ups', title: 'Apple', subject: 'AirPods case', retailer: 'Apple', eta: day(0), status: 'delivered', deliveredAt: now - 3600e3, source: 'email' },
  { id: 's6', code: 'GLS12345678NL', carrier: 'gls', title: 'IKEA', subject: 'Desk lamp', retailer: 'IKEA', eta: day(-1), status: 'shipped', source: 'manual' },
  { id: 's7', code: 'RR123456789NL', carrier: 'postnl', title: 'Etsy', subject: 'Ceramic mug', eta: day(-6), status: 'delivered', confirmed: 'yes', deliveredAt: now - 5 * 864e5, source: 'email' },
  { id: 's8', code: 'TBA123456789012', carrier: 'amazon', title: 'Amazon', subject: 'Kindle Paperwhite', eta: day(-9), status: 'delivered', confirmed: 'yes', deliveredAt: now - 8 * 864e5, source: 'email' },
].map((p, i) => ({ etaWindow: '', postcode: '', note: '', confirmed: '', deleted: false, eta: '', deliveredAt: '', createdAt: now - (10 - i) * 864e5, updatedAt: now - (10 - i) * 864e5, retailer: '', ...p }));
const seeded = JSON.parse(gas.ctx.doPost({ parameter: { token: TOKEN }, postData: { contents: JSON.stringify({ changes: seed }) } }).body);
assert.equal(seeded.ok, true);
assert.equal(seeded.packages.length, seed.length);

// ---------- run ----------
const browser = await chromium.launch();
const results = [];
const check = (name, fn) => Promise.resolve().then(fn).then(() => results.push(['ok', name]), (e) => results.push(['FAIL', name, e.message]));

async function device({ width = 390, height = 844, scheme = 'light', mobile = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP.slice(0, -1) });
  await routeBackend(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => results.push(['FAIL', 'page error', e.message]));
  page.on('dialog', (d) => d.accept());
  return { context, page };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
const settle = (page) => page.waitForTimeout(450);

// Device A: phone, connects via the "copy link for another device" URL.
const A = await device();
await A.page.goto(`${APP}#connect=${encodeURIComponent(LINK)}`);
await A.page.waitForSelector('.row');
await settle(A.page);
await shot(A.page, '01-phone-list');

await check('pending list groups', async () => {
  const labels = await A.page.$$eval('#board .group-label', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(labels, ['Did it arrive? 2', 'Today 1', 'Coming up 2', 'No date yet 1']);
});

await check('expandable row shows status, carrier, expected delivery, tracking link', async () => {
  await A.page.click('.row[data-id="s1"] .row-head');
  await settle(A.page);
  const facts = await A.page.$$eval('.row[data-id="s1"] .facts dt', (els) => els.map((e) => e.textContent));
  for (const f of ['Status', 'Carrier', 'Expected delivery', 'Tracking number']) assert.ok(facts.includes(f), f);
  const href = await A.page.getAttribute('.row[data-id="s1"] .code-link', 'href');
  assert.equal(href, 'https://jouw.postnl.nl/track-and-trace/3SCBLU123456789-NL-5612AB');
  assert.equal(await A.page.getAttribute('.row[data-id="s1"] .code-link', 'target'), '_blank');
  assert.equal(await A.page.getAttribute('.row[data-id="s1"] .row-head', 'aria-expanded'), 'true');
});
await shot(A.page, '02-phone-expanded');

await check('keyboard: Enter toggles a row', async () => {
  await A.page.focus('.row[data-id="s2"] .row-head');
  await A.page.keyboard.press('Enter');
  assert.equal(await A.page.getAttribute('.row[data-id="s2"] .row-head', 'aria-expanded'), 'true');
  await A.page.keyboard.press('Enter');
  assert.equal(await A.page.getAttribute('.row[data-id="s2"] .row-head', 'aria-expanded'), 'false');
});

await check('ask prompt: carrier-delivered and date-passed both ask', async () => {
  const q = await A.page.$$eval('.ask-q', (els) => els.map((e) => e.textContent));
  assert.ok(q.some((t) => /UPS says delivered/.test(t)), q.join('|'));
  assert.ok(q.some((t) => /Expected yesterday/.test(t)), q.join('|'));
});
await A.page.click('.row[data-id="s1"] .row-head'); // collapse again
await A.page.evaluate(() => scrollTo(0, 0));
await shot(A.page, '03-phone-ask', { clip: { x: 0, y: 0, width: 390, height: 420 } });

await check('Yes → moves to Delivered and syncs to the database', async () => {
  await A.page.click('[data-yes="s5"]');
  await A.page.waitForFunction(() => !document.querySelector('[data-yes="s5"]'));
  await A.page.waitForTimeout(2200);
  assert.equal(gas.rows().find((r) => r.id === 's5').confirmed, 'yes');
});

await check('No → drafts a problem email with tracking details', async () => {
  await A.page.click('[data-no="s6"]');
  await A.page.waitForSelector('#mail-sheet[open]');
  const body = await A.page.inputValue('#mail-body');
  assert.match(body, /GLS12345678NL/);
  assert.match(body, /IKEA/);
  assert.match(await A.page.inputValue('#mail-subject'), /Parcel not received – IKEA – tracking GLS12345678NL/);
  await A.page.fill('#mail-to', 'klantenservice@ikea.nl');
  const href = await A.page.getAttribute('#mail-open', 'href');
  assert.ok(href.startsWith('mailto:klantenservice@ikea.nl?subject='), href);
});
await settle(A.page);
await shot(A.page, '04-phone-email-draft');
await A.page.click('#mail-sheet [data-close]');
await A.page.waitForTimeout(2200);
await check('"No" answer synced', () => assert.equal(gas.rows().find((r) => r.id === 's6').confirmed, 'no'));
await shot(A.page, '05-phone-after-answers', { fullPage: true });

// Device B: Windows-size desktop, dark mode, connects by pasting the link in Settings.
const B = await device({ width: 1280, height: 860, scheme: 'dark', mobile: false });
await B.page.goto(APP);
await B.page.click('#settings-btn');
await B.page.fill('#set-inbox', LINK);
await settle(B.page);
await shot(B.page, '06-desktop-settings-dark');
await B.page.click('#inbox-connect');
await B.page.click('#settings-sheet [data-close]');
await B.page.waitForSelector('.row');
await check('device B sees device A answers', async () => {
  assert.equal(await B.page.$('[data-yes="s5"]'), null);
  assert.ok(await B.page.$('.st-problem[data-id="s6"]'));
});
await B.page.click('.row[data-id="s2"] .row-head');
await settle(B.page);
await shot(B.page, '07-desktop-dark');

await check('edit on B reaches A', async () => {
  await B.page.click('.row[data-id="s2"] [data-edit]');
  await B.page.fill('#detail-form [name="title"]', 'bol.com – Hue kit');
  await B.page.click('#detail-form [value="save"]');
  await B.page.waitForTimeout(2200);
  await A.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await A.page.waitForFunction(() => document.querySelector('.row[data-id="s2"] .row-title')?.textContent === 'bol.com – Hue kit');
});

await check('offline edit on A uploads after reconnect', async () => {
  offline = true;
  await A.page.click('.row[data-id="s3"] .row-head');
  await A.page.click('.row[data-id="s3"] [data-remove]');
  await A.page.waitForTimeout(2200);
  assert.equal(gas.rows().find((r) => r.id === 's3').deleted, false);
  assert.match(await A.page.textContent('#sync-label'), /unsynced/);
  offline = false;
  await A.page.click('#sync-btn');
  await A.page.waitForTimeout(800);
  assert.equal(gas.rows().find((r) => r.id === 's3').deleted, true);
  assert.equal(await A.page.$('.row[data-id="s3"]'), null);
});

await check('forwarded email lands on both devices', async () => {
  gas.deliver(fakeMessage({
    id: 'fw1', from: 'Me <me@example.com>', subject: 'Fwd: Your order has shipped',
    body: 'Your DPD parcel 05298765432109 from MediaMarkt is on its way. Expected delivery tomorrow.',
    html: '<a href="https://tracking.dpd.de/status/nl_NL/parcel/05298765432109">Track</a>',
  }));
  gas.ctx.processInbox();
  assert.ok(gas.rows().find((r) => r.code === '05298765432109'));
  await A.page.click('#sync-btn');
  await A.page.waitForSelector('.row .row-sub >> text=DPD');
});

// Empty state + add sheet on a fresh, unconnected phone.
const C = await device({ scheme: 'dark' });
await C.page.goto(APP);
await settle(C.page);
await shot(C.page, '08-phone-empty-dark');
await C.page.click('#add-btn');
await C.page.fill('#paste-text', 'Je pakket van Coolblue is onderweg met PostNL. Track & trace: 3SABCD1234567 Verwacht morgen tussen 14:00 en 16:00.');
await C.page.waitForSelector('#confirm-add');
await settle(C.page);
await shot(C.page, '09-phone-add-dark');
await check('paste → add works offline-only too', async () => {
  await C.page.click('#confirm-add');
  await C.page.waitForSelector('.row');
});

// Light desktop overview for the record (Mac-size window).
const D = await device({ width: 1440, height: 900, mobile: false });
await D.page.goto(`${APP}#connect=${encodeURIComponent(LINK)}`);
await D.page.waitForSelector('.row');
await D.page.click('#toggle-delivered');
await settle(D.page);
await shot(D.page, '10-desktop-light', { fullPage: true });
await shot(A.page, '11-phone-final', { fullPage: true });

await browser.close();
server.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in docs/screenshots/`);
process.exit(failed.length ? 1 : 0);
