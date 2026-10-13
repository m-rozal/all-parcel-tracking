import { CARRIERS, extractPackages, guessCarrier, trackingUrl } from './parser.js';

const VERSION = '2.1.0';
const KEY = 'parcels.v2';
const OLD_KEY = 'parcels.v1';
const STATUSES = [
  ['shipped', 'Shipped'],
  ['out', 'Out for delivery'],
  ['delivered', 'Delivered'],
];
const RANK = { shipped: 0, out: 1, delivered: 2 };
const SYNC_EVERY = 2 * 60 * 1000;
const BATCH = 150; // the web app accepts up to 200 changes per request

const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => isoDate(new Date());
const lowerRel = (t) => (/^(Today|Tomorrow|Yesterday)$/.test(t) ? t.toLowerCase() : t);
const carrierName = (p) => (CARRIERS[p.carrier] || CARRIERS.other).name;
const trackSite = (p) => (p.carrier && p.carrier !== 'other' ? carrierName(p) : '17TRACK');

// ---------- storage ----------
// packages: every record we know, including tombstones (deleted: true) until the server drops them.
// outbox: ids edited here that the server hasn't confirmed yet.

function normalize(p) {
  return {
    id: p.id || uid(), code: p.code || '', carrier: p.carrier || 'other', title: p.title || 'Parcel',
    subject: p.subject || '', retailer: p.retailer || '', eta: p.eta || '', etaWindow: p.etaWindow || '',
    postcode: p.postcode || '', note: p.note || '', status: RANK[p.status] != null ? p.status : 'shipped',
    confirmed: p.confirmed === 'yes' || p.confirmed === 'no' ? p.confirmed : '',
    source: p.source || 'manual', createdAt: Number(p.createdAt) || Date.now(), updatedAt: Number(p.updatedAt) || Date.now(),
    deliveredAt: Number(p.deliveredAt) || '', deleted: p.deleted === true || p.deleted === 'true' || p.deleted === 'TRUE',
  };
}

function load() {
  const fresh = { packages: [], outbox: [], settings: { country: 'NL', postcode: '', inboxUrl: '' }, ui: {} };
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.packages)) return { ...fresh, ...s, settings: { ...fresh.settings, ...s.settings }, ui: { ...s.ui } };
    // v1 kept everything per device: bring it over and queue it all for upload.
    const old = JSON.parse(localStorage.getItem(OLD_KEY));
    if (old && Array.isArray(old.packages)) {
      const packages = old.packages.map((p) => normalize({ ...p, confirmed: p.status === 'delivered' ? 'yes' : '' }));
      return { ...fresh, packages, outbox: packages.map((p) => p.id), settings: { ...fresh.settings, ...old.settings, inboxUrl: '' } };
    }
  } catch { /* fall through to a fresh state */ }
  return fresh;
}

let state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('Could not save on this device'); } };
const live = () => state.packages.filter((p) => !p.deleted);
const byId = (id) => state.packages.find((p) => p.id === id);

/** Record a local edit: stamp it, queue it for the server, re-render. */
function touch(p) {
  p.updatedAt = Math.max(Date.now(), (p.updatedAt || 0) + 1);
  if (!state.outbox.includes(p.id)) state.outbox.push(p.id);
  save();
  render();
  scheduleSync();
}

function setStatus(p, status) {
  p.status = status;
  p.deliveredAt = status === 'delivered' ? p.deliveredAt || Date.now() : '';
}

/** Adds new parcels, or refreshes ones already tracked (a later "out for delivery" email updates the card). */
function upsert(found) {
  let added = 0, updated = 0;
  for (const f of found) {
    const existing = live().find((p) => p.code === f.code);
    if (existing) {
      if (RANK[f.status] > RANK[existing.status] && !existing.confirmed) setStatus(existing, f.status);
      if (f.eta) { existing.eta = f.eta; existing.etaWindow = f.etaWindow || existing.etaWindow; }
      if (f.postcode && !existing.postcode) existing.postcode = f.postcode;
      if (existing.carrier === 'other' && f.carrier && f.carrier !== 'other') existing.carrier = f.carrier;
      if (f.subject && !existing.subject) existing.subject = f.subject;
      if (f.title && /parcel$/i.test(existing.title) && !/parcel$/i.test(f.title)) existing.title = f.title;
      touch(existing);
      updated++;
    } else {
      const p = normalize({ ...f, id: uid(), createdAt: Date.now(), deliveredAt: f.status === 'delivered' ? Date.now() : '' });
      state.packages.push(p);
      touch(p);
      added++;
    }
  }
  return { added, updated };
}

function removePackage(id) {
  const p = byId(id);
  if (!p) return;
  if (!state.settings.inboxUrl) {
    state.packages = state.packages.filter((q) => q !== p);
    state.outbox = state.outbox.filter((q) => q !== id);
    save();
    return render();
  }
  p.deleted = true; // tombstone, so the other devices and the email inbox drop it too
  touch(p);
}

// ---------- sync with the shared database (Apps Script web app, see gmail-inbox/) ----------

let syncing = false, again = false, syncTimer;

function scheduleSync(ms = 1500) {
  clearTimeout(syncTimer);
  if (state.settings.inboxUrl) syncTimer = setTimeout(() => sync({ quiet: true }), ms);
}

function api(changes) {
  const url = new URL(state.settings.inboxUrl);
  url.searchParams.set('_', Date.now()); // dodge caches
  // No Content-Type header: the browser sends text/plain, which needs no CORS preflight.
  const init = changes.length ? { method: 'POST', body: JSON.stringify({ changes }), redirect: 'follow' } : { redirect: 'follow' };
  return fetch(url, init).then((r) => r.json());
}

async function sync({ quiet = true } = {}) {
  if (!state.settings.inboxUrl) return;
  if (syncing) { again = true; return; }
  syncing = true;
  renderSync();
  try {
    const sent = state.outbox.slice(0, BATCH).map(byId).filter(Boolean);
    const sentAt = new Map(sent.map((p) => [p.id, p.updatedAt]));
    const data = await api(sent);
    if (!data.ok) throw new Error(data.error || 'sync failed');

    // Anything edited while the request was in flight stays queued and wins locally.
    const missing = new Set(state.outbox.filter((id) => !byId(id)));
    state.outbox = state.outbox.filter((id) => !missing.has(id) && (!sentAt.has(id) || byId(id).updatedAt !== sentAt.get(id)));
    const pending = new Map(state.outbox.map((id) => [id, byId(id)]));
    const server = (data.packages || []).map(normalize);
    const before = new Set(live().map((p) => p.code));
    state.packages = [...server.filter((p) => !pending.has(p.id)), ...pending.values()];

    // On the first sync everything is "new", so only announce arrivals after that.
    const fresh = state.ui.lastSync ? server.filter((p) => !p.deleted && p.source === 'email' && !before.has(p.code)).length : 0;
    state.ui.lastSync = Date.now();
    state.ui.syncError = '';
    save();
    render();
    if (fresh) toast(`${fresh} new from email`);
    else if (!quiet) toast('Up to date');
    if (state.outbox.length) again = true;
  } catch (err) {
    state.ui.syncError = err.message === 'bad token' ? 'Wrong link or token' : navigator.onLine === false ? 'Offline' : 'Could not reach database';
    save();
    if (!quiet) toast(state.ui.syncError);
  } finally {
    syncing = false;
    renderSync();
    if (again) { again = false; if (!state.ui.syncError) scheduleSync(300); }
  }
}

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function renderSync() {
  const btn = $('#sync-btn');
  const connected = !!state.settings.inboxUrl;
  const n = state.outbox.length;
  btn.hidden = !connected;
  btn.classList.toggle('busy', syncing);
  btn.classList.toggle('error', !!state.ui.syncError);
  btn.classList.toggle('warn', !state.ui.syncError && n > 0 && !syncing);
  const text = syncing ? 'Syncing…'
    : state.ui.syncError ? `${state.ui.syncError}${n ? ` · ${n} unsynced` : ''}`
    : `Synced ${ago(state.ui.lastSync)}`;
  $('#sync-label').textContent = text;
  btn.setAttribute('aria-label', `${text}. Sync now`);
  $('#connect-hint').hidden = connected || !live().length || !!state.ui.connectHintDismissed;
  const status = $('#db-status');
  if (status) {
    status.innerHTML = connected
      ? `<b>Connected</b> · last synced ${esc(ago(state.ui.lastSync))}${state.ui.syncError ? ` · ${esc(state.ui.syncError)}` : ''}${n ? ` · ${n} waiting to upload` : ''}`
      : '<b>Not connected.</b> Parcels stay on this device only.';
  }
  $('#copy-device-link').hidden = !connected;
}

// ---------- grouping ----------

/** Why we're asking "did it arrive?", or null when there's nothing to ask yet. */
function askReason(p, today) {
  if (p.confirmed) return null;
  if (p.status === 'delivered') return `${carrierName(p) === 'Other' ? 'Tracking' : carrierName(p)} says delivered. Did you get it?`;
  if (p.eta && p.eta < today) return `Expected ${lowerRel(relDay(p.eta).text)}. Did it arrive?`;
  return null;
}

function groups() {
  const today = todayISO();
  const all = live();
  const byEta = (a, b) => (a.eta || '9999').localeCompare(b.eta || '9999') || a.createdAt - b.createdAt;
  const open = all.filter((p) => !p.confirmed);
  const ask = open.filter((p) => askReason(p, today)).sort(byEta);
  const waiting = open.filter((p) => !ask.includes(p));
  return {
    today,
    ask,
    todayList: waiting.filter((p) => p.status === 'out' || p.eta === today).sort(byEta),
    soon: waiting.filter((p) => p.status !== 'out' && p.eta > today).sort(byEta),
    undated: waiting.filter((p) => p.status !== 'out' && !p.eta).sort((a, b) => b.createdAt - a.createdAt),
    problems: all.filter((p) => p.confirmed === 'no').sort((a, b) => b.updatedAt - a.updatedAt),
    delivered: all.filter((p) => p.confirmed === 'yes').sort((a, b) => (b.deliveredAt || b.updatedAt) - (a.deliveredAt || a.updatedAt)),
  };
}

// ---------- rendering ----------

function relDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - new Date(new Date().toDateString())) / 864e5);
  const long = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const text = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : long;
  return { text, long, diff, date };
}

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg>',
  chev: '<svg class="row-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  box: '<svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 20l24-12 24 12-24 12z"/><path d="M8 20v24l24 12V32M56 20v24L32 56"/><path d="M20 14l24 12v8"/></svg>',
};

/** The leading date leaf: weekday over day number, or a word/glyph when there's no single day. */
function tile(p, kind) {
  let top, body;
  if (kind === 'done') { top = 'Got it'; body = ICON.check; }
  else if (kind === 'problem') { top = 'Issue'; body = ICON.alert; }
  else if (p.status === 'out' && (!p.eta || p.eta <= todayISO())) { top = 'Today'; body = `<span class="tile-num">${new Date().getDate()}</span>`; }
  else if (p.eta) {
    const { date } = relDay(p.eta);
    top = date.toLocaleDateString('en-GB', { weekday: 'short' });
    body = `<span class="tile-num">${date.getDate()}</span>`;
  } else { top = 'Date'; body = '<span class="tile-num word">—</span>'; }
  return `<span class="tile" aria-hidden="true"><span class="tile-top">${esc(top)}</span>${body}</span>`;
}

function stateText(p, kind) {
  if (kind === 'done') return `Received${p.deliveredAt ? ' ' + lowerRel(relDay(isoDate(new Date(p.deliveredAt))).text) : ''}`;
  if (kind === 'problem') return 'Not received';
  if (p.status === 'delivered') return 'Delivered';
  if (p.status === 'out') return `Out for delivery${p.etaWindow ? ' · ' + p.etaWindow : ''}`;
  if (p.eta) {
    const d = relDay(p.eta);
    return `${d.diff < 0 ? 'Was due' : 'Arrives'} ${d.diff >= 0 && d.diff <= 1 ? d.text.toLowerCase() : d.long}${p.etaWindow ? ' · ' + p.etaWindow : ''}`;
  }
  return 'Shipped · no date yet';
}

function etaText(p) {
  if (!p.eta) return p.status === 'out' ? `Today${p.etaWindow ? ', ' + p.etaWindow : ''}` : 'Not given yet';
  const d = relDay(p.eta);
  const full = d.date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${d.diff >= -1 && d.diff <= 1 ? d.text + ', ' : ''}${full}${p.etaWindow ? ', ' + p.etaWindow : ''}`;
}

function row(p, kind, today) {
  const open = !!state.ui.open?.[p.id];
  const step = RANK[p.status];
  const cls = { ask: 'st-ask', problem: 'st-problem', done: 'st-done' }[kind]
    || (p.status === 'out' || p.eta === today ? 'st-today' : p.eta ? 'st-soon' : 'st-none');
  const reason = kind === 'ask' ? askReason(p, today) : '';
  const statusLabel = kind === 'problem' ? 'Not received (you reported it)'
    : kind === 'done' ? 'Delivered, received'
    : STATUSES[step][1];
  const name = p.title || 'Parcel';
  return `
  <li class="row ${cls}" data-id="${esc(p.id)}">
    <button class="row-head" type="button" aria-expanded="${open}" aria-controls="d-${esc(p.id)}" data-toggle="${esc(p.id)}">
      ${tile(p, kind)}
      <span class="row-text">
        <span class="row-title">${esc(name)}</span>
        <span class="row-sub">${esc(carrierName(p) === 'Other' ? 'Carrier unknown' : carrierName(p))} · <span class="state">${esc(stateText(p, kind))}</span></span>
      </span>
      ${ICON.chev}
    </button>
    ${kind === 'ask' ? `
    <div class="ask">
      <span class="ask-q">${esc(reason)}</span>
      <span class="ask-btns">
        <button class="btn small" type="button" data-yes="${esc(p.id)}">Yes</button>
        <button class="btn small secondary" type="button" data-no="${esc(p.id)}">No</button>
      </span>
    </div>` : ''}
    ${kind === 'problem' ? `
    <div class="ask">
      <span class="ask-q">You said this didn't arrive.</span>
      <span class="ask-btns">
        <button class="btn small" type="button" data-mail="${esc(p.id)}">Draft Email</button>
        <button class="btn small secondary" type="button" data-yes="${esc(p.id)}">It Arrived</button>
      </span>
    </div>` : ''}
    <div class="detail${open ? ' open' : ''}" id="d-${esc(p.id)}" role="region" aria-label="${esc(name)} details"${open ? '' : ' inert'}>
      <div><div class="detail-inner">
        <dl class="facts">
          <dt>Status</dt>
          <dd><span class="track"><span class="track-steps" aria-hidden="true">${STATUSES.map((_, s) => `<i class="${s <= step ? 'on' : ''}"></i>`).join('')}</span>${esc(statusLabel)}</span></dd>
          <dt>Carrier</dt><dd>${esc(carrierName(p) === 'Other' ? 'Unknown' : carrierName(p))}</dd>
          <dt>Expected delivery</dt><dd>${esc(etaText(p))}</dd>
          <dt>Tracking number</dt>
          <dd><a class="code-link" href="${esc(trackingUrl(p, state.settings))}" target="_blank" rel="noopener" aria-label="${esc(p.code)}, open tracking at ${esc(trackSite(p))}">${esc(p.code)}</a></dd>
          ${p.subject && p.subject !== name ? `<dt>What's inside</dt><dd>${esc(p.subject)}</dd>` : ''}
          ${p.retailer && p.retailer !== name ? `<dt>Shop</dt><dd>${esc(p.retailer)}</dd>` : ''}
          ${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ''}
        </dl>
        <div class="detail-actions">
          <button class="btn small secondary" type="button" data-copy="${esc(p.code)}">Copy Number</button>
          <button class="btn small secondary" type="button" data-edit="${esc(p.id)}">Edit</button>
          ${kind === 'done' || kind === 'problem' ? '' : `<button class="btn small secondary" type="button" data-yes="${esc(p.id)}">Mark Received</button>`}
          <button class="btn small danger" type="button" data-remove="${esc(p.id)}">Delete</button>
        </div>
      </div></div>
    </div>
  </li>`;
}

function section(title, list, kind, today, cls = '') {
  if (!list.length) return '';
  return `<section class="group" aria-label="${esc(title)}">
    <h2 class="group-label ${cls}">${esc(title)} <span class="count">${list.length}</span></h2>
    <ul class="list card">${list.map((p) => row(p, kind, today)).join('')}</ul></section>`;
}

function render() {
  const g = groups();
  const pending = g.todayList.length + g.soon.length + g.undated.length;
  const bits = [
    pending ? `${pending} on the way` : '',
    g.ask.length ? `${g.ask.length} to confirm` : '',
    g.problems.length ? `${g.problems.length} with a problem` : '',
  ].filter(Boolean);
  $('#summary').textContent = bits.length ? bits.join(' · ') : live().length ? 'Nothing on the way' : '';

  if (!live().length) {
    $('#board').innerHTML = `
      <div class="empty">
        ${ICON.box}
        <h2>No parcels yet</h2>
        <p>Forward shipping emails to <b>littlehelper689@gmail.com</b> and they appear here. Or add one by pasting the email or a tracking number.</p>
        <div class="button-row center">
          <button class="btn" type="button" data-add>Add Parcel</button>
          ${state.settings.inboxUrl ? '' : '<button class="btn secondary" type="button" data-connect>Connect Database</button>'}
        </div>
      </div>`;
    return;
  }

  const showDelivered = !!state.ui.showDelivered;
  $('#board').innerHTML = [
    section('Did it arrive?', g.ask, 'ask', g.today, 'attention'),
    section('Today', g.todayList, 'pending', g.today),
    section('Coming up', g.soon, 'pending', g.today),
    section('No date yet', g.undated, 'pending', g.today),
    section('Not received', g.problems, 'problem', g.today, 'problem'),
    pending || g.ask.length || g.problems.length ? '' : '<div class="empty"><h2>All caught up</h2><p>Everything has arrived.</p></div>',
    g.delivered.length ? `
    <section class="group">
      <button class="group-toggle" type="button" id="toggle-delivered" aria-expanded="${showDelivered}" aria-controls="delivered-list">
        Delivered <span class="count">${g.delivered.length}</span>
        <svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      ${showDelivered ? `<ul class="list card" id="delivered-list">${g.delivered.map((p) => row(p, 'done', g.today)).join('')}</ul>` : ''}
    </section>` : '',
  ].join('');
}

function toggleRow(id) {
  state.ui.open ??= {};
  const open = !state.ui.open[id];
  if (open) state.ui.open[id] = true; else delete state.ui.open[id];
  save();
  // Flip in place rather than re-render, so the height transition plays.
  const li = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (!li) return render();
  $('.row-head', li).setAttribute('aria-expanded', open);
  const d = $('.detail', li);
  d.classList.toggle('open', open);
  d.toggleAttribute('inert', !open);
}

// ---------- arrival answers + problem email ----------

function markReceived(id) {
  const p = byId(id);
  if (!p) return;
  p.confirmed = 'yes';
  setStatus(p, 'delivered');
  touch(p);
  toast(`${p.title} received`);
}

function markMissing(id) {
  const p = byId(id);
  if (!p) return;
  p.confirmed = 'no';
  touch(p);
  openMail(id);
}

function draftEmail(p, settings = {}) {
  const who = p.retailer || (p.title && !/parcel$/i.test(p.title) ? p.title : '');
  const what = p.subject && p.subject !== who ? ` (${p.subject})` : '';
  const carrier = carrierName(p) === 'Other' ? '' : carrierName(p);
  const due = p.eta ? relDay(p.eta).date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const happened = p.status === 'delivered'
    ? `The tracking page says it was delivered${p.deliveredAt ? ' on ' + new Date(p.deliveredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : ''}, but it did not reach me. I've checked with neighbours and around the building.`
    : `It was expected${due ? ' on ' + due : ''} and still hasn't arrived.`;
  const subject = `Parcel not received${who ? ' – ' + who : ''} – tracking ${p.code}`;
  const body = [
    'Hello,',
    '',
    `I haven't received my parcel${who ? ' from ' + who : ''}${what}. ${happened}`,
    '',
    `Tracking number: ${p.code}`,
    carrier ? `Carrier: ${carrier}` : '',
    `Tracking page: ${trackingUrl(p, settings)}`,
    due ? `Expected delivery: ${due}` : '',
    '',
    'Could you please look into this and let me know whether you can send a replacement or give a refund?',
    '',
    'Thank you,',
    settings.name || '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { subject, body };
}

const mailSheet = $('#mail-sheet');

function openMail(id) {
  const p = byId(id);
  if (!p) return;
  const { subject, body } = draftEmail(p, state.settings);
  $('#mail-to').value = '';
  $('#mail-subject').value = subject;
  $('#mail-body').value = body;
  updateMailLink();
  mailSheet.showModal();
}

function updateMailLink() {
  const to = $('#mail-to').value.trim();
  const q = `subject=${encodeURIComponent($('#mail-subject').value)}&body=${encodeURIComponent($('#mail-body').value)}`;
  $('#mail-open').href = `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?${q}`;
}

// ---------- add flow ----------

const addSheet = $('#add-sheet');
let scanned = [];

function openAdd(text = '') {
  $('#paste-text').value = text;
  $('#scan-results').innerHTML = '';
  scanned = [];
  addSheet.showModal();
  if (text) scan();
}

function carrierOptions(selected) {
  return Object.entries(CARRIERS).map(([id, c]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

function scan() {
  const text = $('#paste-text').value;
  scanned = extractPackages(text);
  const box = $('#scan-results');
  if (!text.trim()) { box.innerHTML = ''; return; }
  if (!scanned.length) {
    box.innerHTML = `<div class="notice">
      <p><b>No tracking number found.</b> Some emails hide it behind a button. Open the shop's tracking page and copy the number or link from there, or enter it by hand.</p>
      <button type="button" class="btn secondary" id="manual-from-scan">Enter by Hand</button></div>`;
    return;
  }
  const known = new Set(live().map((p) => p.code));
  box.innerHTML = `
    <p class="found-head">Found ${scanned.length} parcel${scanned.length > 1 ? 's' : ''}</p>
    <div class="card">
    ${scanned.map((p, k) => `
      <div class="found">
        <input type="checkbox" checked data-pick="${k}" aria-label="Add ${esc(p.code)}">
        <div class="found-body">
          <input data-title="${k}" value="${esc(p.title)}" aria-label="Name">
          <div class="found-meta">
            <code>${esc(p.code)}</code>
            <select data-carrier="${k}" aria-label="Carrier">${carrierOptions(p.carrier)}</select>
          </div>
          <p class="found-extra">${[
            known.has(p.code) ? 'Already tracked, will update' : '',
            p.eta ? `Expected ${relDay(p.eta).text}${p.etaWindow ? ' ' + p.etaWindow : ''}` : '',
            p.status !== 'shipped' ? STATUSES[RANK[p.status]][1] : '',
          ].filter(Boolean).map(esc).join(' · ')}</p>
        </div>
      </div>`).join('')}
    </div>
    <div class="button-row"><button type="button" class="btn wide" id="confirm-add">Add ${scanned.length > 1 ? scanned.length + ' Parcels' : 'Parcel'}</button></div>`;
}

function confirmAdd() {
  const box = $('#scan-results');
  const picked = scanned
    .map((p, k) => ({
      ...p,
      source: 'paste',
      title: $(`[data-title="${k}"]`, box).value.trim() || p.title,
      carrier: $(`[data-carrier="${k}"]`, box).value,
      _on: $(`[data-pick="${k}"]`, box).checked,
    }))
    .filter((p) => p._on);
  if (!picked.length) return toast('Nothing selected');
  const { added, updated } = upsert(picked);
  addSheet.close();
  toast([added && `Added ${added}`, updated && `Updated ${updated}`].filter(Boolean).join(' · '));
}

async function readClipboard() {
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

// ---------- edit sheet ----------

const detailSheet = $('#detail-sheet');

function openDetail(id) {
  const isNew = !id;
  const p = isNew
    ? { id: null, code: '', carrier: 'other', title: '', eta: '', etaWindow: '', postcode: '', note: '', status: 'shipped' }
    : byId(id);
  if (!p) return;
  $('#detail-form').innerHTML = `
    <div class="sheet-head">
      <button type="button" class="text-btn" data-close>Cancel</button>
      <h2 id="detail-title">${isNew ? 'Add by Hand' : 'Edit Parcel'}</h2>
      <button type="submit" class="text-btn strong" value="save">${isNew ? 'Add' : 'Save'}</button>
    </div>
    <label class="field"><span class="field-label">Name</span><input name="title" value="${esc(p.title)}" placeholder="e.g. New headphones"></label>
    <div class="field-row">
      <label class="field grow"><span class="field-label">Tracking number</span><input name="code" value="${esc(p.code)}" autocapitalize="characters" autocomplete="off" spellcheck="false" required></label>
      <label class="field"><span class="field-label">Carrier</span><select name="carrier">${carrierOptions(p.carrier)}</select></label>
    </div>
    <div class="field-row">
      <label class="field grow"><span class="field-label">Expected delivery</span><input type="date" name="eta" value="${esc(p.eta)}"></label>
      <label class="field grow"><span class="field-label">Time window</span><input name="etaWindow" value="${esc(p.etaWindow)}" placeholder="14:00–16:00"></label>
    </div>
    <label class="field" data-postcode ${p.carrier === 'postnl' ? '' : 'hidden'}><span class="field-label">Postcode on parcel (PostNL)</span><input name="postcode" value="${esc(p.postcode)}" placeholder="${esc(state.settings.postcode || '1234 AB')}"></label>
    <fieldset class="seg">
      <legend>Carrier status</legend>
      ${STATUSES.map(([v, l]) => `<label><input type="radio" name="status" value="${v}"${p.status === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}
    </fieldset>
    <label class="field"><span class="field-label">Note</span><textarea name="note" rows="2" placeholder="What's inside, where to pick up…">${esc(p.note)}</textarea></label>`;
  detailSheet.dataset.id = id || '';
  detailSheet.showModal();
}

function saveDetail(form) {
  const f = new FormData(form);
  const code = String(f.get('code') || '').toUpperCase().replace(/[\s-]/g, '');
  if (!code) { toast('Tracking number needed'); return false; }
  const fields = {
    title: String(f.get('title') || '').trim() || 'Parcel',
    code,
    carrier: f.get('carrier'),
    eta: f.get('eta') || '',
    etaWindow: String(f.get('etaWindow') || '').trim(),
    postcode: String(f.get('postcode') || '').trim().toUpperCase(),
    note: String(f.get('note') || '').trim(),
  };
  const status = f.get('status') || 'shipped';
  const id = detailSheet.dataset.id;
  if (id) {
    const p = byId(id);
    if (status !== p.status) setStatus(p, status);
    // A new date means it's not late any more: ask again later instead of keeping an old "no".
    if (fields.eta !== p.eta && p.confirmed === 'no' && fields.eta >= todayISO()) p.confirmed = '';
    Object.assign(p, fields);
    touch(p);
    toast('Saved');
  } else {
    if (fields.carrier === 'other') fields.carrier = guessCarrier(code);
    const { updated } = upsert([{ ...fields, status, source: 'manual' }]);
    toast(updated ? 'Already tracked, updated' : 'Added');
  }
  return true;
}

// ---------- settings ----------

const settingsSheet = $('#settings-sheet');

function openSettings() {
  $('#set-name').value = state.settings.name || '';
  $('#set-postcode').value = state.settings.postcode || '';
  $('#set-country').value = state.settings.country || 'NL';
  $('#set-inbox').value = state.settings.inboxUrl || '';
  $('#version').textContent = `v${VERSION}`;
  renderSync();
  settingsSheet.showModal();
}

const LINK_RE = /^https:\/\/script\.google\.com\/macros\/(?:u\/\d+\/)?s\/[^/]+\/exec\?(?:.*&)?token=[A-Za-z0-9]+/;

function connect(link) {
  const v = link.trim();
  if (v && !LINK_RE.test(v)) { toast('Paste the full link ending in ?token=…'); return false; }
  state.settings.inboxUrl = v;
  state.ui.syncError = '';
  // Everything on this device gets uploaded; the server merges by tracking number.
  if (v) state.outbox = [...new Set([...state.outbox, ...state.packages.map((p) => p.id)])];
  save();
  renderSync();
  if (v) sync().then(() => toast(state.ui.syncError || 'Connected to your database')); else toast('Disconnected');
  return true;
}

// ---------- misc ----------

let toastTimer;
function toast(msg) {
  if (!msg) return;
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function copy(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch { prompt('Copy this:', text); }
}

// Close a <dialog> via its Cancel/Done or when the backdrop is tapped.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

// ---------- events ----------

$('#add-btn').addEventListener('click', () => openAdd());
$('#settings-btn').addEventListener('click', openSettings);
$('#sync-btn').addEventListener('click', () => sync({ quiet: false }));

$('#clip-btn').addEventListener('click', async () => {
  const text = await readClipboard();
  if (text == null) return toast('Clipboard blocked. Long-press the box and choose Paste.');
  $('#paste-text').value = text;
  scan();
});
$('#manual-btn').addEventListener('click', () => { addSheet.close(); openDetail(null); });
let scanTimer;
$('#paste-text').addEventListener('input', () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); });
$('#scan-results').addEventListener('click', (e) => {
  if (e.target.id === 'confirm-add') confirmAdd();
  if (e.target.id === 'manual-from-scan') { addSheet.close(); openDetail(null); }
});

$('#board').addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle],[data-copy],[data-yes],[data-no],[data-mail],[data-edit],[data-remove],[data-add],[data-connect],#toggle-delivered');
  if (!t) return;
  const d = t.dataset;
  if (t.id === 'toggle-delivered') { state.ui.showDelivered = !state.ui.showDelivered; save(); return render(); }
  if (d.toggle) return toggleRow(d.toggle);
  if (d.copy) return copy(d.copy, 'Tracking number copied');
  if (d.yes) return markReceived(d.yes);
  if (d.no) return markMissing(d.no);
  if (d.mail) return openMail(d.mail);
  if (d.edit) return openDetail(d.edit);
  if (d.add != null) return openAdd();
  if (d.connect != null) return openSettings();
  if (d.remove) {
    const p = byId(d.remove);
    if (p && confirm(`Delete “${p.title}” from all your devices?`)) { removePackage(d.remove); toast('Deleted'); }
  }
});

$('#detail-form').addEventListener('change', (e) => {
  if (e.target.name === 'carrier') $('[data-postcode]', detailSheet).hidden = e.target.value !== 'postnl';
});
$('#detail-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save' && !saveDetail(e.target)) e.preventDefault();
});

for (const id of ['#mail-to', '#mail-subject', '#mail-body']) $(id).addEventListener('input', updateMailLink);
$('#mail-copy').addEventListener('click', () => copy(`Subject: ${$('#mail-subject').value}\n\n${$('#mail-body').value}`, 'Email copied'));

$('#set-name').addEventListener('change', (e) => { state.settings.name = e.target.value.trim(); save(); });
$('#set-postcode').addEventListener('change', (e) => { state.settings.postcode = e.target.value.trim().toUpperCase(); save(); render(); });
$('#set-country').addEventListener('change', (e) => { state.settings.country = e.target.value; save(); render(); });
$('#inbox-connect').addEventListener('click', () => connect($('#set-inbox').value));
$('#copy-device-link').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}#connect=${encodeURIComponent(state.settings.inboxUrl)}`;
  copy(link, 'Link copied. Open it on your other device.');
});
$('#clear-delivered').addEventListener('click', () => {
  const done = live().filter((p) => p.confirmed === 'yes');
  if (!done.length) return toast('No delivered parcels');
  if (!confirm(`Remove ${done.length} delivered parcel${done.length > 1 ? 's' : ''} from all devices?`)) return;
  for (const p of done) { p.deleted = true; p.updatedAt = Date.now(); if (!state.outbox.includes(p.id)) state.outbox.push(p.id); }
  save();
  render();
  scheduleSync();
  settingsSheet.close();
});

$('#connect-open').addEventListener('click', openSettings);

// iOS Safari (not yet installed): nudge toward Add to Home Screen.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone && !state.ui.installHintDismissed) {
  $('#install-hint').hidden = false;
}
$('#install-dismiss').addEventListener('click', () => { state.ui.installHintDismissed = true; save(); $('#install-hint').hidden = true; });

// Refresh relative dates ("Tomorrow" → "Today") and pull changes when the app comes back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  render();
  sync();
});
addEventListener('online', () => sync());

// Link from "Copy Link for Another Device": #connect=<web app link>. Also text from a Shortcut: ?text=… or #add=…
const hash = new URLSearchParams(location.hash.slice(1));
const incoming = new URLSearchParams(location.search).get('text') ?? hash.get('add');
if (hash.get('connect') || incoming) history.replaceState(null, '', location.pathname);

render();
renderSync();
if (hash.get('connect')) {
  // A link can point anywhere: say which database, and only switch with consent.
  const link = hash.get('connect');
  const id = (link.match(/\/s\/([^/]+)\/exec/) || [])[1] || '?';
  const short = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
  const ask = state.settings.inboxUrl && state.settings.inboxUrl !== link
    ? `Switch this device to a different parcel database (script ${short})? Your parcels here will be copied into it.`
    : `Connect this device to your parcel database (script ${short})? Parcels on this device will be copied into it.`;
  if (state.settings.inboxUrl === link) sync();
  else if (confirm(ask)) connect(link);
  else sync();
} else {
  sync();
}
setInterval(() => { if (!document.hidden) sync(); }, SYNC_EVERY);
setInterval(renderSync, 30 * 1000);
if (incoming) openAdd(incoming);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
