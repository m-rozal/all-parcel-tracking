// Fake Google services (Gmail, Sheets, Properties, Triggers…) that run Parser.gs + Code.gs in a bare VM.
// Shared by tests/inbox.test.mjs and the end-to-end check in tests/e2e/.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../gmail-inbox/${f}`, import.meta.url), 'utf8');

export function fakeMessage({ id, from, subject, body, html = '', date = new Date(2026, 9, 11), headers = {} }) {
  return {
    getId: () => id, getFrom: () => from, getSubject: () => subject, getDate: () => date,
    getPlainBody: () => body, getBody: () => html, getReplyTo: () => '', getHeader: (h) => headers[h] || '',
  };
}

// In-memory Sheet: a 2-D array of cells. Like Sheets, getValues returns copies padded to the
// range size, and a date-looking string written to a cell without '@' format becomes a Date.
function fakeSheet() {
  const cells = [];
  const text = new Set(); // "row,col" with number format '@'
  const sheet = {
    name: 'Sheet1', frozen: 0, maxRows: 1000, cells, text,
    setName(n) { this.name = n; return this; },
    getName() { return this.name; },
    getMaxRows() { return this.maxRows; },
    insertRowsAfter(after, n) { this.maxRows += n; return this; },
    setFrozenRows(n) { this.frozen = n; return this; },
    getLastRow() {
      for (let r = cells.length; r > 0; r--) if ((cells[r - 1] || []).some((v) => v !== '')) return r;
      return 0;
    },
    getLastColumn() { return Math.max(0, ...cells.map((row) => row.reduce((m, v, i) => (v !== '' ? i + 1 : m), 0))); },
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); },
    getRange(r, c, nr = 1, nc = 1) {
      if (r + nr - 1 > sheet.maxRows) throw new Error('Range outside sheet');
      const each = (fn) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(r + i, c + j, i, j); };
      const put = (row, col, v) => {
        while (cells.length < row) cells.push([]);
        const line = cells[row - 1];
        while (line.length < col) line.push('');
        line[col - 1] = v;
      };
      const range = {
        getValues() {
          const out = Array.from({ length: nr }, () => Array(nc).fill(''));
          each((row, col, i, j) => { const v = (cells[row - 1] || [])[col - 1]; out[i][j] = v === undefined ? '' : v; });
          return out;
        },
        setValues(vals) {
          if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues: wrong size');
          each((row, col, i, j) => {
            let v = vals[i][j];
            if (typeof v === 'string' && v[0] === "'") v = v.slice(1); // quote prefix: forced text, not stored
            else if (typeof v === 'string' && v[0] === '=') v = { formula: v };
            if (!text.has(row + ',' + col) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
              const [y, m, d] = v.split('-').map(Number);
              v = new Date(y, m - 1, d);
            }
            put(row, col, v);
          });
          return range;
        },
        setNumberFormat(f) { each((row, col) => (f === '@' ? text.add(row + ',' + col) : text.delete(row + ',' + col))); return range; },
        clearContent() { each((row, col) => { if (cells[row - 1] && col <= cells[row - 1].length) cells[row - 1][col - 1] = ''; }); return range; },
      };
      return range;
    },
  };
  return sheet;
}

export function makeEnv({ messages = [], props = {}, fetch, sheet = true, rows: seed = [] } = {}) {
  const store = { ALLOWED_SENDERS: '*', ...props };
  const thread = { labels: [], read: false, getMessages: () => messages, addLabel(l) { this.labels.push(l.name); }, markRead() { this.read = true; } };
  const label = (name) => ({ name });
  const files = {};
  const newSpreadsheet = (name) => {
    const id = 'sheet' + (Object.keys(files).length + 1);
    const tab = fakeSheet();
    files[id] = { name, tab, getId: () => id, getSheets: () => [tab], getSheetByName: (n) => (tab.name === n ? tab : null) };
    return files[id];
  };
  const triggers = [];
  const lock = { tryLock: () => true, waitLock() {}, releaseLock() {} };
  const ctx = {
    console: { log() {}, warn() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => store[k] ?? null, setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; }, getProperties: () => ({ ...store }),
    }) },
    LockService: { getScriptLock: () => lock, getUserLock: () => lock },
    GmailApp: { search: () => [thread], getUserLabelByName: label, createLabel: label },
    UrlFetchApp: { fetch: fetch || (() => ({ getResponseCode: () => 200, getAllHeaders: () => ({}) })) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => ({ body: s }) }) },
    Utilities: { getUuid: () => 'uuid-' + Math.random().toString(16).slice(2) },
    SpreadsheetApp: {
      create: (name) => newSpreadsheet(name),
      openById: (id) => { if (!files[id]) throw new Error('no such file'); return files[id]; },
      flush() {},
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => {
        const t = { fn, n, getHandlerFunction: () => fn };
        triggers.push(t);
        return t;
      } }) }) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('Parser.gs'), ctx);
  vm.runInContext(read('Code.gs'), ctx);
  const COLUMNS = vm.runInContext('COLUMNS', ctx);
  let tab = null;
  if (sheet) {
    const ss = newSpreadsheet('Parcels database');
    tab = ss.tab;
    tab.setName('parcels');
    store.SHEET_ID = ss.getId();
    tab.getRange(1, 1, tab.maxRows, COLUMNS.length).setNumberFormat('@');
    const values = [COLUMNS, ...seed.map((r) => COLUMNS.map((k) => r[k] ?? ''))];
    tab.getRange(1, 1, values.length, COLUMNS.length).setValues(values);
  }
  // The fake Sheet as records (header row → keys), straight from the cells.
  const rows = () => {
    const t = tab || files[store.SHEET_ID].tab;
    const [header, ...data] = t.getDataRange().getValues();
    return data.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  };
  const get = (token = 'secret') => JSON.parse(ctx.doGet({ parameter: { token } }).body);
  const post = (body, token = 'secret') => JSON.parse(ctx.doPost({ parameter: { token },
    postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'text/plain' } }).body);
  return { ctx, store, thread, messages, files, triggers, rows, get, post, COLUMNS };
}
