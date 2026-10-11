// Runs the Apps Script inbox job (Parser.gs + Code.gs) in a bare VM with fake Google services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../gmail-inbox/${f}`, import.meta.url), 'utf8');

function fakeMessage({ id, from, subject, body, html = '', date = new Date(2026, 9, 11), headers = {} }) {
  return {
    getId: () => id, getFrom: () => from, getSubject: () => subject, getDate: () => date,
    getPlainBody: () => body, getBody: () => html, getReplyTo: () => '', getHeader: (h) => headers[h] || '',
  };
}

function makeEnv({ messages = [], props = {}, fetch } = {}) {
  const store = { ...props };
  const thread = { labels: [], read: false, getMessages: () => messages, addLabel(l) { this.labels.push(l.name); }, markRead() { this.read = true; } };
  const label = (name) => ({ name });
  const ctx = {
    console: { log() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => store[k] ?? null, setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; }, getProperties: () => ({ ...store }),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    GmailApp: { search: () => [thread], getUserLabelByName: label, createLabel: label },
    UrlFetchApp: { fetch: fetch || (() => ({ getResponseCode: () => 200, getAllHeaders: () => ({}) })) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }) },
    Utilities: { getUuid: () => 'uuid' },
  };
  vm.createContext(ctx);
  vm.runInContext(read('Parser.gs'), ctx);
  vm.runInContext(read('Code.gs'), ctx);
  return { ctx, store, thread };
}

const POSTNL_MAIL = {
  id: 'm1', from: 'Coolblue <noreply@coolblue.nl>', subject: 'Je bestelling is onderweg',
  body: 'Je pakket wordt verwacht op 13 oktober tussen 14:00 en 16:00.',
  html: '<a href="https://jouw.postnl.nl/track-and-trace/3SCBLU123456789-NL-5612AB">Volg je pakket</a>',
};

test('runs without browser globals (no URL / URLSearchParams in Apps Script)', () => {
  const { ctx } = makeEnv();
  assert.equal(typeof ctx.URL, 'undefined');
  const r = ctx.parseTrackingUrl('https://t.17track.net/en#nums=RR123456789DE');
  assert.equal(r.carrier, 'dhl');
});

test('processInbox logs a parcel whose number only exists in an HTML button link', () => {
  const { ctx, store, thread } = makeEnv({ messages: [fakeMessage(POSTNL_MAIL)] });
  ctx.processInbox();
  const saved = JSON.parse(store['pkg:3SCBLU123456789']);
  assert.equal(saved.carrier, 'postnl');
  assert.equal(saved.postcode, '5612AB');
  assert.equal(saved.title, 'Coolblue');
  assert.equal(saved.eta, '2026-10-13');
  assert.equal(saved.source, 'email');
  assert.deepEqual(thread.labels, ['Parcels/Logged']);
  // Second run: message already seen, nothing re-processed.
  thread.labels = [];
  ctx.processInbox();
  assert.deepEqual(thread.labels, []);
});

test('ALLOWED_SENDERS blocks strangers but accepts forwards', () => {
  const stranger = fakeMessage({ ...POSTNL_MAIL, id: 'm2', from: 'spam@evil.test' });
  const a = makeEnv({ messages: [stranger], props: { ALLOWED_SENDERS: 'me@gmail.com' } });
  a.ctx.processInbox();
  assert.equal(Object.keys(a.store).filter((k) => k.startsWith('pkg:')).length, 0);

  const forwarded = fakeMessage({ ...POSTNL_MAIL, id: 'm3', headers: { 'X-Forwarded-For': 'me@gmail.com parcels@gmail.com' } });
  const b = makeEnv({ messages: [forwarded], props: { ALLOWED_SENDERS: 'me@gmail.com' } });
  b.ctx.processInbox();
  assert.ok(b.store['pkg:3SCBLU123456789']);
});

test('click-tracker links are followed to the carrier URL', () => {
  const msg = fakeMessage({
    id: 'm4', from: 'Shop <hi@shop.test>', subject: 'Shipped', body: 'Your order is on its way.',
    html: '<a href="https://click.shop.test/r/abc">Track your parcel</a>',
  });
  const fetch = (url) => ({
    getResponseCode: () => (url.includes('click.shop.test') ? 302 : 200),
    getAllHeaders: () => (url.includes('click.shop.test') ? { Location: 'https://www.ups.com/track?tracknum=1Z999AA10123456784' } : {}),
  });
  const { ctx, store } = makeEnv({ messages: [msg], fetch });
  ctx.processInbox();
  assert.equal(JSON.parse(store['pkg:1Z999AA10123456784']).carrier, 'ups');
});

test('Claude results enrich regex hits; invented numbers are rejected', () => {
  const { ctx } = makeEnv();
  const text = 'From: bol.com\nYour DHL parcel JVGL06240512345678901 with headphones ships today. Order 123456789.';
  const regex = ctx.extractPackages(text, new Date(2026, 9, 11));
  const claude = { is_shipping_email: true, packages: [
    { tracking_number: 'JVGL06240512345678901', carrier: 'dhl', retailer: 'bol.com', item_description: 'Sony headphones', expected_date: '2026-10-14', time_window: '', status: 'shipped' },
    { tracking_number: 'JVGL99999999999999999', carrier: 'dhl', retailer: '', item_description: '', expected_date: '', time_window: '', status: 'shipped' },
  ] };
  const merged = ctx.mergeResults(regex, claude, text);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].subject, 'Sony headphones');
  assert.equal(merged[0].eta, '2026-10-14');
  assert.equal(merged[0].title, 'bol.com');
});

test('Claude request: structured output, fallback header only on supported models', () => {
  let sent;
  const fetch = (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.payload) };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"is_shipping_email":false,"packages":[]}' }] }) };
  };
  const { ctx } = makeEnv({ props: { ANTHROPIC_API_KEY: 'k' }, fetch });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.claudeExtract('hello'))), { is_shipping_email: false, packages: [] });
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');

  const h = makeEnv({ props: { ANTHROPIC_API_KEY: 'k', CLAUDE_MODEL: 'claude-haiku-5-5' }, fetch });
  h.ctx.claudeExtract('hello');
  assert.equal(sent.body.fallbacks, undefined);
  assert.equal(sent.opts.headers['anthropic-beta'], undefined);
});

test('no API key: Claude is skipped, regex still works', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.claudeExtract('x'), null);
});

test('doGet requires the token and supports dismiss', () => {
  const { ctx, store } = makeEnv({ props: { TOKEN: 'secret', 'pkg:ABC12345678': '{"code":"ABC12345678"}' } });
  assert.equal(JSON.parse(ctx.doGet({ parameter: { token: 'nope' } }).body).ok, false);
  const ok = JSON.parse(ctx.doGet({ parameter: { token: 'secret' } }).body);
  assert.equal(ok.packages.length, 1);
  ctx.doGet({ parameter: { token: 'secret', dismiss: 'abc12345678' } });
  assert.equal(store['pkg:ABC12345678'], undefined);
});
