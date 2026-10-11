import { CARRIERS, extractPackages, guessCarrier, trackingUrl, universalUrl } from './parser.js';

const VERSION = '1.0.0';
const KEY = 'parcels.v1';
const STATUSES = [
  ['shipped', 'Shipped'],
  ['out', 'Out for delivery'],
  ['delivered', 'Delivered'],
];
const RANK = { shipped: 0, out: 1, delivered: 2 };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayISO = () => isoDate(new Date());
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- storage ----------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.packages)) return { settings: { country: 'NL', postcode: '' }, ...s };
  } catch { /* fall through to a fresh state */ }
  return { packages: [], settings: { country: 'NL', postcode: '' }, ui: {} };
}
let state = load();
state.ui ??= {};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('Could not save — storage full or blocked'); } };
const byId = (id) => state.packages.find((p) => p.id === id);

/** Adds new packages, or refreshes ones we already track (a later "out for delivery" email updates the card). */
function upsert(found) {
  let added = 0, updated = 0;
  for (const f of found) {
    const existing = state.packages.find((p) => p.code === f.code);
    if (existing) {
      if (RANK[f.status] > RANK[existing.status]) setStatus(existing, f.status);
      if (f.eta) { existing.eta = f.eta; existing.etaWindow = f.etaWindow || existing.etaWindow; }
      if (f.postcode && !existing.postcode) existing.postcode = f.postcode;
      if (existing.carrier === 'other' && f.carrier !== 'other') existing.carrier = f.carrier;
      existing.updatedAt = Date.now();
      updated++;
    } else {
      const now = Date.now();
      state.packages.push({
        id: uid(), code: f.code, carrier: f.carrier, title: f.title || 'Parcel', subject: f.subject || '',
        retailer: f.retailer || '', eta: f.eta || '', etaWindow: f.etaWindow || '', postcode: f.postcode || '',
        note: '', status: f.status || 'shipped', createdAt: now, updatedAt: now,
        deliveredAt: f.status === 'delivered' ? now : null,
      });
      added++;
    }
  }
  save();
  render();
  return { added, updated };
}

function setStatus(p, status) {
  p.status = status;
  p.deliveredAt = status === 'delivered' ? Date.now() : null;
  p.updatedAt = Date.now();
}

// ---------- rendering ----------

function relDay(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - new Date(new Date().toDateString())) / 864e5);
  const pretty = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (diff === 0) return { text: 'Today', diff };
  if (diff === 1) return { text: 'Tomorrow', diff };
  if (diff === -1) return { text: 'Yesterday', diff };
  return { text: pretty, diff };
}

function barcode(code) {
  // Decorative bars derived from the code, so each label looks like its own.
  let x = 0, bars = '';
  for (const ch of `*${code}*`) {
    const n = ch.charCodeAt(0);
    for (let i = 0; i < 3; i++) {
      const w = 1 + ((n >> (i * 2)) & 1) + ((n >> (i + 3)) & 1);
      if (i % 2 === 0) bars += `<rect x="${x}" width="${w}" height="30"/>`;
      x += w + 1;
    }
  }
  return `<svg class="barcode" viewBox="0 0 ${x} 30" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}

function card(p, i) {
  const c = CARRIERS[p.carrier] || CARRIERS.other;
  const day = relDay(p.eta);
  const late = day && day.diff < 0 && p.status !== 'delivered';
  let when;
  if (p.status === 'delivered') when = `Delivered ${relDay(isoDate(new Date(p.deliveredAt || p.updatedAt))).text.toLowerCase()}`;
  else if (p.status === 'out') when = `Out for delivery${p.etaWindow ? ` · ${p.etaWindow}` : ''}`;
  else if (day) when = `${late ? 'Expected ' : ''}${day.text}${p.etaWindow ? ` · ${p.etaWindow}` : ''}`;
  else when = 'No date yet';
  const step = RANK[p.status];

  return `
  <article class="label ${p.status}${late ? ' late' : ''}" data-id="${p.id}" style="--c:${c.color};--ci:${c.ink};--i:${i}">
    <button class="label-hit" data-open="${p.id}" aria-label="Open ${esc(p.title)}"></button>
    <div class="label-band">
      <span class="carrier">${esc(c.name)}</span>
      <span class="when">${esc(when)}${late ? ' <em>late?</em>' : ''}</span>
    </div>
    <div class="label-body">
      <h3 class="label-title">${esc(p.title)}</h3>
      ${p.subject && p.subject !== p.title ? `<p class="label-sub">${esc(p.subject)}</p>` : ''}
      ${barcode(p.code)}
      <div class="code-row">
        <code>${esc(p.code)}</code>
        <button class="mini" data-copy="${esc(p.code)}" aria-label="Copy tracking number">Copy</button>
      </div>
      <ol class="steps" aria-label="Status: ${esc(STATUSES[step][1])}">
        ${STATUSES.map(([, label], s) => `<li class="${s <= step ? 'done' : ''}${s === step ? ' now' : ''}"><span>${label}</span></li>`).join('')}
      </ol>
    </div>
    <div class="label-foot">
      <a class="btn track" href="${esc(trackingUrl(p, state.settings))}" target="_blank" rel="noopener">Track at ${esc(c.name === 'Other' ? '17TRACK' : c.name)} ↗</a>
      ${p.status !== 'delivered'
        ? `<button class="btn ghost" data-delivered="${p.id}">Got it ✓</button>`
        : `<button class="btn ghost" data-remove="${p.id}">Remove</button>`}
    </div>
  </article>`;
}

function section(title, list, start, extra = '') {
  if (!list.length) return '';
  return `<section class="group"><h2 class="group-title">${title}<span>${list.length}</span>${extra}</h2>
    <div class="labels">${list.map((p, i) => card(p, start + i)).join('')}</div></section>`;
}

function render() {
  const today = todayISO();
  const active = state.packages.filter((p) => p.status !== 'delivered');
  const delivered = state.packages.filter((p) => p.status === 'delivered').sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0));
  const byEta = (a, b) => (a.eta || '9999').localeCompare(b.eta || '9999') || a.createdAt - b.createdAt;

  const todayList = active.filter((p) => p.status === 'out' || p.eta === today).sort(byEta);
  const late = active.filter((p) => !todayList.includes(p) && p.eta && p.eta < today).sort(byEta);
  const soon = active.filter((p) => !todayList.includes(p) && p.eta > today).sort(byEta);
  const undated = active.filter((p) => !todayList.includes(p) && !p.eta).sort((a, b) => b.createdAt - a.createdAt);

  $('#stamp').textContent = `${active.length} inbound`;
  $('#stamp').classList.toggle('zero', !active.length);
  $('#dateline').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  if (!state.packages.length) {
    $('#board').innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 120 100" class="empty-box" aria-hidden="true">
          <path d="M10 30 L60 10 L110 30 L60 50 Z" /><path d="M10 30 V75 L60 95 V50" /><path d="M110 30 V75 L60 95" />
          <path d="M35 20 L85 40 V55" class="tape"/>
        </svg>
        <h2>Nothing inbound.</h2>
        <p>Open a shipping email, select all and copy it, then tap <b>Paste shipping email</b>. Tracking numbers, carrier, shop and delivery date get picked out for you.</p>
        <p class="tiny">Works with PostNL, DHL, DPD, UPS, GLS, FedEx, Amazon, Budbee, AliExpress/Cainiao and more.</p>
      </div>`;
    return;
  }

  let i = 0;
  const html = [
    section('Today', todayList, i),
    section('Overdue', late, (i += todayList.length)),
    section('Coming up', soon, (i += late.length)),
    section('No date yet', undated, (i += soon.length)),
  ].join('');
  i += undated.length;
  const showDelivered = state.ui.showDelivered;
  const deliveredHtml = delivered.length ? `
    <section class="group delivered-group">
      <button class="group-title toggle" id="toggle-delivered" aria-expanded="${!!showDelivered}">
        Delivered<span>${delivered.length}</span><i>${showDelivered ? 'Hide' : 'Show'}</i>
      </button>
      ${showDelivered ? `<div class="labels">${delivered.map((p, k) => card(p, i + k)).join('')}</div>` : ''}
    </section>` : '';
  $('#board').innerHTML = (html || `<div class="empty small"><h2>All caught up.</h2><p>Everything has arrived.</p></div>`) + deliveredHtml;
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
      <b>No tracking number found.</b> Some emails hide it behind a button — open the shop's tracking page and copy the number or link from there, or add it by hand.
      <button type="button" class="btn ghost" id="manual-from-scan">Add by hand</button></div>`;
    return;
  }
  const known = new Set(state.packages.map((p) => p.code));
  box.innerHTML = `
    <p class="found-head">Found ${scanned.length} package${scanned.length > 1 ? 's' : ''}</p>
    ${scanned.map((p, k) => `
      <div class="found" data-k="${k}">
        <label class="check"><input type="checkbox" checked data-pick="${k}"><span></span></label>
        <div class="found-body">
          <input class="found-title" data-title="${k}" value="${esc(p.title)}" aria-label="Name">
          <div class="found-meta">
            <code>${esc(p.code)}</code>
            <select data-carrier="${k}" aria-label="Carrier">${carrierOptions(p.carrier)}</select>
          </div>
          <p class="found-extra">${[
            known.has(p.code) ? 'Already tracking — will update' : '',
            p.eta ? `ETA ${relDay(p.eta).text}${p.etaWindow ? ' ' + p.etaWindow : ''}` : '',
            p.status !== 'shipped' ? STATUSES[RANK[p.status]][1] : '',
          ].filter(Boolean).map(esc).join(' · ')}</p>
        </div>
      </div>`).join('')}
    <button type="button" class="btn wide" id="confirm-add">Add to tracker</button>`;
}

function confirmAdd() {
  const box = $('#scan-results');
  const picked = scanned
    .map((p, k) => ({
      ...p,
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
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

async function pasteFlow() {
  const text = await readClipboard();
  if (text == null) return openAdd(); // permission denied / unsupported: let them paste by hand
  openAdd(text);
  if (!text.trim()) toast('Clipboard is empty — paste below');
}

// ---------- detail sheet ----------

const detailSheet = $('#detail-sheet');

function openDetail(id) {
  const isNew = !id;
  const p = isNew
    ? { id: null, code: '', carrier: 'other', title: '', eta: '', etaWindow: '', postcode: '', note: '', status: 'shipped' }
    : byId(id);
  if (!p) return;
  const c = CARRIERS[p.carrier] || CARRIERS.other;
  $('#detail-form').innerHTML = `
    <div class="sheet-head">
      <h2>${isNew ? 'Add by hand' : esc(p.title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
    </div>
    <label class="field"><span>Name</span><input name="title" value="${esc(p.title)}" placeholder="e.g. New headphones"></label>
    <div class="row">
      <label class="field grow"><span>Tracking number</span><input name="code" value="${esc(p.code)}" autocapitalize="characters" autocomplete="off" spellcheck="false" required></label>
      <label class="field"><span>Carrier</span><select name="carrier">${carrierOptions(p.carrier)}</select></label>
    </div>
    <div class="row">
      <label class="field grow"><span>Expected</span><input type="date" name="eta" value="${esc(p.eta)}"></label>
      <label class="field grow"><span>Time window</span><input name="etaWindow" value="${esc(p.etaWindow)}" placeholder="14:00–16:00"></label>
    </div>
    <label class="field" data-postcode ${p.carrier === 'postnl' ? '' : 'hidden'}><span>Postcode on parcel (PostNL)</span><input name="postcode" value="${esc(p.postcode)}" placeholder="${esc(state.settings.postcode || '1234 AB')}"></label>
    <fieldset class="seg">
      <legend>Status</legend>
      ${STATUSES.map(([v, l]) => `<label><input type="radio" name="status" value="${v}"${p.status === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}
    </fieldset>
    <label class="field"><span>Note</span><textarea name="note" rows="2" placeholder="What's inside, where to pick up…">${esc(p.note)}</textarea></label>
    ${isNew ? '' : `
    <div class="row links">
      <a class="btn ghost" href="${esc(trackingUrl(p, state.settings))}" target="_blank" rel="noopener">${esc(c.name === 'Other' ? '17TRACK' : c.name)} ↗</a>
      <a class="btn ghost" href="${esc(universalUrl(p.code))}" target="_blank" rel="noopener">17TRACK ↗</a>
    </div>`}
    <div class="row">
      ${isNew ? '' : `<button type="button" class="btn danger ghost" data-delete="${p.id}">Delete</button>`}
      <button type="submit" class="btn grow" value="save">${isNew ? 'Add' : 'Save'}</button>
    </div>`;
  detailSheet.dataset.id = id || '';
  detailSheet.showModal();
}

function saveDetail(form) {
  const f = new FormData(form);
  const code = String(f.get('code') || '').toUpperCase().replace(/[\s-]/g, '');
  if (!code) return toast('Tracking number needed');
  const fields = {
    title: String(f.get('title') || '').trim() || 'Parcel',
    code,
    carrier: f.get('carrier'),
    eta: f.get('eta') || '',
    etaWindow: String(f.get('etaWindow') || '').trim(),
    postcode: String(f.get('postcode') || '').trim().toUpperCase(),
    note: String(f.get('note') || '').trim(),
  };
  const id = detailSheet.dataset.id;
  if (id) {
    const p = byId(id);
    const status = f.get('status');
    if (status !== p.status) setStatus(p, status);
    Object.assign(p, fields, { updatedAt: Date.now() });
    save();
    render();
    toast('Saved');
  } else {
    if (fields.carrier === 'other') fields.carrier = guessCarrier(code);
    const { updated } = upsert([{ ...fields, status: f.get('status') }]);
    toast(updated ? 'Already tracked — updated' : 'Added');
  }
}

// ---------- settings / sync ----------

const settingsSheet = $('#settings-sheet');

function openSettings() {
  $('#set-postcode').value = state.settings.postcode || '';
  $('#set-country').value = state.settings.country || 'NL';
  $('#import-box').hidden = true;
  $('#version').textContent = VERSION;
  settingsSheet.showModal();
}

async function exportData() {
  const data = JSON.stringify({ app: 'parcels', v: 1, packages: state.packages, settings: state.settings });
  try {
    await navigator.clipboard.writeText(data);
    toast(`Copied ${state.packages.length} parcels`);
  } catch {
    $('#import-box').hidden = false;
    $('#import-text').value = data;
    $('#import-text').select();
    toast('Copy the text in the box');
  }
}

function importData() {
  try {
    const data = JSON.parse($('#import-text').value);
    if (!Array.isArray(data.packages)) throw new Error();
    let n = 0;
    for (const p of data.packages) {
      if (!p.code) continue;
      const existing = state.packages.find((q) => q.code === p.code);
      if (!existing) { state.packages.push({ ...p, id: uid() }); n++; }
      else if ((p.updatedAt || 0) > (existing.updatedAt || 0)) { Object.assign(existing, { ...p, id: existing.id }); n++; }
    }
    if (!state.settings.postcode && data.settings?.postcode) state.settings.postcode = data.settings.postcode;
    save();
    render();
    settingsSheet.close();
    toast(`Imported ${n}`);
  } catch {
    toast("That doesn't look like exported Parcels data");
  }
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

// Close a <dialog> via its ✕ or when the backdrop is tapped.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

// ---------- events ----------

$('#paste-btn').addEventListener('click', pasteFlow);
$('#add-btn').addEventListener('click', () => openDetail(null));
$('#settings-btn').addEventListener('click', openSettings);

$('#clip-btn').addEventListener('click', async () => {
  const text = await readClipboard();
  if (text == null) return toast('Clipboard blocked — long-press the box and Paste');
  $('#paste-text').value = text;
  scan();
});
$('#scan-btn').addEventListener('click', scan);
let scanTimer;
$('#paste-text').addEventListener('input', () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 350); });
$('#scan-results').addEventListener('click', (e) => {
  if (e.target.id === 'confirm-add') confirmAdd();
  if (e.target.id === 'manual-from-scan') { addSheet.close(); openDetail(null); }
});

$('#board').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-copy],[data-delivered],[data-remove],#toggle-delivered');
  if (!t) return;
  if (t.id === 'toggle-delivered') { state.ui.showDelivered = !state.ui.showDelivered; save(); return render(); }
  if (t.dataset.open) return openDetail(t.dataset.open);
  if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast('Tracking number copied'); } catch { toast(t.dataset.copy); }
    return;
  }
  if (t.dataset.delivered) {
    const p = byId(t.dataset.delivered);
    const el = t.closest('.label');
    el.classList.add('stamping');
    setTimeout(() => { setStatus(p, 'delivered'); save(); render(); toast(`${p.title} delivered`); }, 520);
    return;
  }
  if (t.dataset.remove) {
    state.packages = state.packages.filter((p) => p.id !== t.dataset.remove);
    save();
    render();
  }
});

$('#detail-form').addEventListener('change', (e) => {
  if (e.target.name === 'carrier') $('[data-postcode]', detailSheet).hidden = e.target.value !== 'postnl';
});
$('#detail-form').addEventListener('click', (e) => {
  const del = e.target.closest('[data-delete]');
  if (del && confirm('Delete this parcel?')) {
    state.packages = state.packages.filter((p) => p.id !== del.dataset.delete);
    save();
    render();
    detailSheet.close();
  }
});
$('#detail-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') saveDetail(e.target);
});

$('#set-postcode').addEventListener('change', (e) => { state.settings.postcode = e.target.value.trim().toUpperCase(); save(); render(); });
$('#set-country').addEventListener('change', (e) => { state.settings.country = e.target.value; save(); render(); });
$('#export-btn').addEventListener('click', exportData);
$('#import-toggle').addEventListener('click', () => { $('#import-box').hidden = !$('#import-box').hidden; });
$('#import-btn').addEventListener('click', importData);
$('#clear-delivered').addEventListener('click', () => {
  const n = state.packages.filter((p) => p.status === 'delivered').length;
  if (!n || !confirm(`Remove ${n} delivered parcel${n > 1 ? 's' : ''}?`)) return;
  state.packages = state.packages.filter((p) => p.status !== 'delivered');
  save();
  render();
  settingsSheet.close();
});

// iOS Safari (not yet installed): nudge toward Add to Home Screen.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone && !state.ui.installHintDismissed) {
  $('#install-hint').hidden = false;
}
$('#install-dismiss').addEventListener('click', () => { state.ui.installHintDismissed = true; save(); $('#install-hint').hidden = true; });

// Refresh relative dates ("Tomorrow" → "Today") when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

render();
// Staggered card entrance only on launch, not on every re-render.
setTimeout(() => document.body.classList.add('booted'), 1200);

// Text handed over by an iOS Shortcut or bookmarklet: ?text=… or #add=…
const incoming = new URLSearchParams(location.search).get('text') ?? new URLSearchParams(location.hash.slice(1)).get('add');
if (incoming) {
  history.replaceState(null, '', location.pathname);
  openAdd(incoming);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
