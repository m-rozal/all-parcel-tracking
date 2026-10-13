// Runs the Apps Script inbox job (Parser.gs + Code.gs) in a bare VM with fake Google services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMessage, makeEnv } from './fake-gas.mjs';

const DAY = 864e5;
const rec = (o) => ({ id: 'a1', code: 'ABC12345678', carrier: 'postnl', title: 'Shop', subject: '', retailer: '', eta: '',
  etaWindow: '', postcode: '', note: '', status: 'shipped', confirmed: '', source: 'manual',
  createdAt: 1000, updatedAt: 1000, deliveredAt: '', deleted: false, ...o });

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
  const { ctx, thread, rows } = makeEnv({ messages: [fakeMessage(POSTNL_MAIL)] });
  ctx.processInbox();
  assert.equal(rows().length, 1);
  const saved = rows()[0];
  assert.equal(saved.code, '3SCBLU123456789');
  assert.match(saved.id, /^em-3SCBLU123456789-/);
  assert.equal(saved.carrier, 'postnl');
  assert.equal(saved.postcode, '5612AB');
  assert.equal(saved.title, 'Coolblue');
  assert.equal(saved.eta, '2026-10-13');
  assert.equal(saved.source, 'email');
  assert.equal(saved.confirmed, '');
  assert.equal(saved.deleted, false);
  assert.equal(saved.createdAt, new Date(2026, 9, 11).getTime());
  assert.deepEqual(thread.labels, ['Parcels/Logged']);
  // Second run: message already seen, nothing re-processed.
  thread.labels = [];
  ctx.processInbox();
  assert.deepEqual(thread.labels, []);
  assert.equal(rows().length, 1);
});

test('ALLOWED_SENDERS blocks strangers but accepts forwards', () => {
  const stranger = fakeMessage({ ...POSTNL_MAIL, id: 'm2', from: 'spam@evil.test' });
  const a = makeEnv({ messages: [stranger], props: { ALLOWED_SENDERS: 'me@gmail.com' } });
  a.ctx.processInbox();
  assert.equal(a.rows().length, 0);

  const forwarded = fakeMessage({ ...POSTNL_MAIL, id: 'm3', headers: { 'X-Forwarded-For': 'me@gmail.com parcels@gmail.com' } });
  const b = makeEnv({ messages: [forwarded], props: { ALLOWED_SENDERS: 'me@gmail.com' } });
  b.ctx.processInbox();
  assert.equal(b.rows()[0].code, '3SCBLU123456789');
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
  const { ctx, rows } = makeEnv({ messages: [msg], fetch });
  ctx.processInbox();
  assert.equal(rows().find((r) => r.code === '1Z999AA10123456784').carrier, 'ups');
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


// ---------- Sheet storage + setup ----------

test('setup creates the token, the "Parcels database" sheet with a text-formatted header, and one trigger', () => {
  const { ctx, store, files, triggers, COLUMNS } = makeEnv({ sheet: false });
  ctx.setup();
  assert.match(store.TOKEN, /^[0-9a-z]+$/);
  const file = files[store.SHEET_ID];
  assert.equal(file.name, 'Parcels database');
  assert.equal(file.tab.name, 'parcels');
  assert.equal(file.tab.frozen, 1);
  assert.deepEqual(file.tab.cells[0], [...COLUMNS]);
  assert.deepEqual([...COLUMNS], ['id', 'code', 'carrier', 'title', 'subject', 'retailer', 'eta', 'etaWindow', 'postcode',
    'note', 'status', 'confirmed', 'source', 'createdAt', 'updatedAt', 'deliveredAt', 'deleted']);
  assert.ok(file.tab.text.has('2,7') && file.tab.text.has('1000,17'), 'whole sheet is plain text');
  assert.deepEqual(triggers.map((t) => [t.fn, t.n]), [['processInbox', 5]]);

  // Re-running keeps the token and the sheet, and doesn't stack triggers.
  const { TOKEN, SHEET_ID } = store;
  ctx.setup();
  assert.equal(store.TOKEN, TOKEN);
  assert.equal(store.SHEET_ID, SHEET_ID);
  assert.equal(Object.keys(files).length, 1);
  assert.equal(triggers.length, 1);
});

test('rotateToken replaces the token; the old one stops working', () => {
  const { ctx, store, get } = makeEnv({ props: { TOKEN: 'secret' } });
  ctx.rotateToken();
  assert.notEqual(store.TOKEN, 'secret');
  assert.equal(get('secret').ok, false);
  assert.equal(get(store.TOKEN).ok, true);
});

test('doGet requires the token and returns every row, tombstones included', () => {
  const { ctx, get } = makeEnv({ props: { TOKEN: 'secret' },
    rows: [rec({ id: 'a1' }), rec({ id: 'a2', code: 'XYZ98765432', deleted: 'TRUE' })] });
  assert.deepEqual(get('nope'), { ok: false, error: 'bad token' });
  assert.equal(JSON.parse(ctx.doGet({}).body).ok, false);
  const res = get();
  assert.equal(res.ok, true);
  assert.match(res.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(res.packages.map((p) => [p.id, p.deleted]), [['a1', false], ['a2', true]]);
  assert.equal(res.packages[0].createdAt, 1000);
  assert.equal(res.packages[0].deliveredAt, '');
});

test('doGet with no token configured refuses everyone', () => {
  const { get } = makeEnv();
  assert.equal(get(undefined).ok, false);
});

test('a date cell that lost its text format is still read back as YYYY-MM-DD', () => {
  const { get, files, store } = makeEnv({ props: { TOKEN: 'secret' }, rows: [rec({})] });
  files[store.SHEET_ID].tab.cells[1][6] = new Date(2026, 9, 14);
  assert.equal(get().packages[0].eta, '2026-10-14');
});

// ---------- doPost sync ----------

test('doPost inserts a new record and replies with the full list', () => {
  const { post, rows } = makeEnv({ props: { TOKEN: 'secret' }, rows: [rec({ id: 'old', code: 'OLD12345678' })] });
  const res = post({ changes: [rec({ id: 'n1', code: 'NEW12345678', eta: '2026-10-14', updatedAt: 2000 })] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.packages.map((p) => p.id), ['old', 'n1']);
  const saved = rows()[1];
  assert.equal(saved.eta, '2026-10-14');
  assert.equal(typeof saved.eta, 'string');
});

test('doPost updates by id when newer and ignores stale edits', () => {
  const { post, rows } = makeEnv({ props: { TOKEN: 'secret' }, rows: [rec({ title: 'Old', updatedAt: 5000 })] });
  post({ changes: [rec({ title: 'Newer', status: 'out', updatedAt: 6000 })] });
  assert.equal(rows()[0].title, 'Newer');
  assert.equal(rows()[0].status, 'out');
  const res = post({ changes: [rec({ title: 'Stale', updatedAt: 5500 })] });
  assert.equal(res.packages[0].title, 'Newer');
  assert.equal(rows().length, 1);
});

test('doPost merges a second device\'s manual add of the same code into the existing row', () => {
  const { post, rows } = makeEnv({ props: { TOKEN: 'secret' },
    rows: [rec({ id: 'em-ABC12345678-x', source: 'email', updatedAt: 1000, createdAt: 900 })] });
  const res = post({ changes: [rec({ id: 'phone-1', code: 'abc 1234-5678', title: 'Shoes', updatedAt: 2000, createdAt: '' })] });
  assert.equal(res.packages.length, 1);
  assert.equal(rows()[0].id, 'em-ABC12345678-x');
  assert.equal(rows()[0].title, 'Shoes');
  assert.equal(rows()[0].createdAt, 900);
});

test('a delete round-trips as a tombstone, and a later add of that code makes a new row', () => {
  const { post, get, rows } = makeEnv({ props: { TOKEN: 'secret' }, rows: [rec({})] });
  post({ changes: [rec({ deleted: true, updatedAt: 3000 })] });
  assert.deepEqual(get().packages.map((p) => [p.id, p.deleted]), [['a1', true]]);
  // Code matching skips tombstones, so re-adding the parcel on another device inserts.
  post({ changes: [rec({ id: 'b1', updatedAt: 4000 })] });
  assert.deepEqual(rows().map((r) => [r.id, r.deleted]), [['a1', true], ['b1', false]]);
});

test('doPost sanitizes input: known fields only, normalised code, valid enums, capped strings', () => {
  const { post } = makeEnv({ props: { TOKEN: 'secret' } });
  const res = post({ changes: [
    { id: ' x1 ', code: ' 3scb lu-123456 ', status: 'lost', confirmed: 'maybe', source: 'hacker', evil: '<script>',
      carrier: 'Teleport', title: '  Hi  ', note: 'n'.repeat(3000), subject: 's'.repeat(900), eta: 'tomorrow', updatedAt: '5', createdAt: 'x', deleted: 'false' },
    { code: 'NOID12345678' }, { id: 'nocode' }, null, 'junk',
  ] });
  assert.equal(res.packages.length, 1);
  const p = res.packages[0];
  assert.equal(p.id, 'x1');
  assert.equal(p.code, '3SCBLU123456');
  assert.equal(p.status, 'shipped');
  assert.equal(p.confirmed, '');
  assert.equal(p.source, 'manual');
  assert.equal(p.carrier, 'other');
  assert.equal(p.title, 'Hi');
  assert.equal(p.note.length, 2000);
  assert.equal(p.subject.length, 500);
  assert.equal(p.eta, '');
  assert.equal(p.updatedAt, 5);
  assert.equal(p.createdAt, '');
  assert.equal(p.deleted, false);
  assert.equal('evil' in p, false);
});

test('doPost rejects a bad token, malformed bodies and oversized batches', () => {
  const { ctx, post, rows } = makeEnv({ props: { TOKEN: 'secret' } });
  assert.deepEqual(post({ changes: [rec({})] }, 'nope'), { ok: false, error: 'bad token' });
  assert.deepEqual(post('not json'), { ok: false, error: 'bad request' });
  assert.deepEqual(post('null'), { ok: false, error: 'bad request' });
  assert.deepEqual(post({ changes: 'x' }), { ok: false, error: 'bad request' });
  assert.deepEqual(JSON.parse(ctx.doPost({ parameter: { token: 'secret' } }).body), { ok: false, error: 'bad request' });
  const many = Array.from({ length: 201 }, (_, i) => rec({ id: 'r' + i, code: 'CODE' + (10000000 + i) }));
  assert.deepEqual(post({ changes: many }), { ok: false, error: 'too many changes' });
  assert.equal(rows().length, 0);
});

test('text that looks like a formula is stored as plain text', () => {
  const { post, rows } = makeEnv({ props: { TOKEN: 'secret' } });
  post({ changes: [rec({ title: '=IMPORTXML("https://evil.test", "//a")' })] });
  assert.equal(rows()[0].title, '=IMPORTXML("https://evil.test", "//a")');
});

// ---------- email ingest ----------

const DELIVERED_MAIL = { ...POSTNL_MAIL, id: 'm9', subject: 'Bezorgd', body: 'Je pakket is bezorgd.' };

test('email ingest fills blanks, takes the eta, and only moves status forward', () => {
  const messages = [fakeMessage(POSTNL_MAIL)];
  const { ctx, rows } = makeEnv({ messages,
    rows: [rec({ id: 'mine', code: '3SCBLU123456789', carrier: 'other', title: 'Parcel', status: 'out', note: 'keep me' })] });
  ctx.processInbox();
  let r = rows()[0];
  assert.equal(rows().length, 1);
  assert.equal(r.id, 'mine');
  assert.equal(r.status, 'out'); // email says shipped; don't go back
  assert.equal(r.carrier, 'postnl');
  assert.equal(r.title, 'Coolblue');
  assert.equal(r.postcode, '5612AB');
  assert.equal(r.eta, '2026-10-13');
  assert.equal(typeof r.eta, 'string');
  assert.equal(r.etaWindow, '14:00–16:00');
  assert.equal(r.note, 'keep me');
  assert.ok(r.updatedAt > 1000);

  messages.push(fakeMessage(DELIVERED_MAIL));
  ctx.processInbox();
  r = rows()[0];
  assert.equal(r.status, 'delivered');
  assert.ok(r.deliveredAt > 0);
});

test('email ingest leaves status alone once the owner answered "did it arrive?"', () => {
  const { ctx, rows } = makeEnv({ messages: [fakeMessage(DELIVERED_MAIL)],
    rows: [rec({ code: '3SCBLU123456789', confirmed: 'no', status: 'shipped', title: 'My shoes' })] });
  ctx.processInbox();
  const r = rows()[0];
  assert.equal(r.status, 'shipped');
  assert.equal(r.deliveredAt, '');
  assert.equal(r.confirmed, 'no');
  assert.equal(r.title, 'My shoes'); // a real title is never replaced
});

test('email ingest does not resurrect a parcel the owner deleted', () => {
  const deletedAt = Date.now() - DAY; // recent, so pruning keeps it
  const { ctx, rows } = makeEnv({ messages: [fakeMessage(POSTNL_MAIL)],
    rows: [rec({ code: '3SCBLU123456789', deleted: true, updatedAt: deletedAt })] });
  ctx.processInbox();
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].deleted, true);
  assert.equal(rows()[0].updatedAt, deletedAt);
});

test('an email with nothing new does not bump updatedAt (so it cannot beat a newer app edit)', () => {
  const { ctx, rows } = makeEnv({ messages: [fakeMessage(POSTNL_MAIL)],
    rows: [rec({ code: '3SCBLU123456789', title: 'Coolblue', subject: 'x', retailer: 'Coolblue', postcode: '5612AB',
      eta: '2026-10-13', etaWindow: '14:00–16:00', updatedAt: 1000 })] });
  ctx.processInbox();
  assert.equal(rows()[0].updatedAt, 1000);
});

test('processInbox prunes old tombstones and long-confirmed parcels', () => {
  const now = Date.now();
  const { ctx, rows } = makeEnv({ rows: [
    rec({ id: 'gone', deleted: true, updatedAt: now - 61 * DAY }),
    rec({ id: 'recent-delete', code: 'B2345678901', deleted: true, updatedAt: now - 10 * DAY }),
    rec({ id: 'old-yes', code: 'C2345678901', confirmed: 'yes', updatedAt: now - 181 * DAY }),
    rec({ id: 'yes', code: 'D2345678901', confirmed: 'yes', updatedAt: now - 100 * DAY }),
    rec({ id: 'old-open', code: 'E2345678901', confirmed: 'no', updatedAt: now - 400 * DAY }),
  ] });
  ctx.processInbox();
  assert.deepEqual(rows().map((r) => r.id), ['recent-delete', 'yes', 'old-open']);
});
