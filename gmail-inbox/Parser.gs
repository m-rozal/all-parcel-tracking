// GENERATED from parser.js by scripts/build-gas.mjs. Do not edit here.

// Pulls tracking numbers (plus carrier, shop, ETA) out of pasted shipping emails.
// Pure functions only, so it runs in the browser and under `node --test`.

const CARRIERS = {
  postnl: { name: 'PostNL', color: '#ff6200', ink: '#fff',
    url: (c, o) => `https://jouw.postnl.nl/track-and-trace/${c}-${o.country || 'NL'}-${(o.postcode || '').replace(/\s/g, '')}` },
  dhl: { name: 'DHL', color: '#ffcc00', ink: '#d40511',
    url: (c) => `https://www.dhl.com/nl-nl/home/tracking.html?tracking-id=${c}&submit=1` },
  dpd: { name: 'DPD', color: '#dc0032', ink: '#fff',
    url: (c) => `https://tracking.dpd.de/status/nl_NL/parcel/${c}` },
  ups: { name: 'UPS', color: '#351c15', ink: '#ffb500',
    url: (c) => `https://www.ups.com/track?loc=nl_NL&tracknum=${c}` },
  gls: { name: 'GLS', color: '#061ab1', ink: '#ffd100',
    url: (c) => `https://gls-group.com/NL/nl/pakket-volgen?match=${c}` },
  fedex: { name: 'FedEx', color: '#4d148c', ink: '#ff6600',
    url: (c) => `https://www.fedex.com/fedextrack/?trknbr=${c}` },
  amazon: { name: 'Amazon', color: '#232f3e', ink: '#ff9900',
    url: () => 'https://www.amazon.nl/gp/css/order-history' },
  budbee: { name: 'Budbee', color: '#2ad9b0', ink: '#111',
    url: (c) => `https://tracking.budbee.com/${c}` },
  bpost: { name: 'bpost', color: '#ef2637', ink: '#fff',
    url: (c) => `https://track.bpost.cloud/btr/web/#/search?itemCode=${c}&lang=nl` },
  royalmail: { name: 'Royal Mail', color: '#e1001a', ink: '#fff',
    url: (c) => `https://www.royalmail.com/track-your-item#/tracking-results/${c}` },
  usps: { name: 'USPS', color: '#333366', ink: '#fff',
    url: (c) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${c}` },
  cainiao: { name: 'Cainiao', color: '#ff6a00', ink: '#fff',
    url: (c) => `https://global.cainiao.com/newDetail.htm?mailNoList=${c}` },
  other: { name: 'Other', color: '#1a1714', ink: '#f2c230',
    url: (c) => universalUrl(c) },
};

const universalUrl = (code) => `https://t.17track.net/en#nums=${encodeURIComponent(code)}`;

function trackingUrl(pkg, settings = {}) {
  const carrier = CARRIERS[pkg.carrier] || CARRIERS.other;
  return carrier.url(pkg.code, { postcode: pkg.postcode || settings.postcode, country: settings.country });
}

// Codes whose shape alone identifies the carrier. Order matters: most specific first.
const STRONG = [
  { carrier: 'ups', re: /\b1Z[0-9A-Z]{16}\b/gi },
  { carrier: 'postnl', re: /\b3S[A-Z]{4}\d{7,11}\b/gi },
  { carrier: 'dhl', re: /\bJVGL\d{12,22}\b/gi },
  { carrier: 'dhl', re: /\bJJD\d{10,24}\b/gi },
  { carrier: 'amazon', re: /\bTBA\d{9,15}\b/gi },
  { carrier: 'cainiao', re: /\b(?:LP|CNG?|CAINIAO)\d{12,18}\b/gi },
  { carrier: 's10', re: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/gi },
  { carrier: 'usps', re: /\b9[2-5]\d{20}\b/g },
];

// UPU S10 codes (e.g. RR123456789NL) end in the origin country.
const S10_COUNTRY = { NL: 'postnl', DE: 'dhl', BE: 'bpost', GB: 'royalmail', US: 'usps', CN: 'cainiao' };

// Carrier names as they show up in email text. UPS is case-sensitive to avoid "groups", "pick-ups".
const CARRIER_WORDS = [
  ['postnl', /post\s?nl/i], ['dhl', /\bdhl\b/i], ['dpd', /\bdpd\b/i], ['ups', /\bUPS\b/],
  ['gls', /\bgls\b/i], ['fedex', /fed\s?ex/i], ['budbee', /budbee/i], ['bpost', /\bbpost\b/i],
  ['royalmail', /royal\s?mail/i], ['usps', /\busps\b/i], ['cainiao', /cainiao/i],
];

const HOSTS = [
  ['postnl', /postnl\./], ['dhl', /dhl\./], ['dpd', /dpd\./], ['ups', /(^|\.)ups\.com$/],
  ['gls', /gls-?(group|info)?\./], ['fedex', /fedex\./], ['budbee', /budbee\./], ['bpost', /bpost\./],
  ['royalmail', /royalmail\./], ['usps', /usps\./], ['cainiao', /cainiao\./], ['other', /17track\.|parcelsapp\./],
];

const TRACK_PARAMS = /^(tracking-?id|tracking[_-]?(number|nr|code)|tracknum|tracknums|trknbr|tracknumbers|barcode|b|match|parcelnumber|parcelnr|parcel|piececode|idc|awb|tlabels|nums|code|query|q|id|mailnolist|itemcode)$/i;

const LABEL = /\b(?:track(?:ing)?\s*(?:&|and|en|\+)\s*trace|tracking|track|zending|barcode|pakket|verzend|sendungs|parcel|shipment|volg|colli)(?:\s*-?\s*(?:nummer|number|no\.?|nr\.?|id|code|link))?(?:\s+(?:is|luidt|ist))?(?:\s*[:#]\s*|\s+)([A-Z0-9][A-Z0-9-]{7,34})\b/gi;

const SHOPS = ['bol.com', 'Coolblue', 'Amazon', 'Zalando', 'AliExpress', 'Temu', 'Shein', 'MediaMarkt', 'IKEA',
  'HEMA', 'Wehkamp', 'Decathlon', 'Apple', 'Nike', 'Adidas', 'H&M', 'ASOS', 'About You', 'Kruidvat', 'Megekko',
  'Alternate', 'Azerty', 'Conrad', 'Otto', 'Etsy', 'Vinted', 'Marktplaats', 'eBay', 'Uniqlo', 'Zara', 'Lidl',
  'Action', 'Bever', 'Thomann', 'Bax-shop', 'Fonq', 'Blokker', 'Gamma', 'Praxis', 'Ali Express', 'Douglas',
  'Rituals', 'Samsung', 'Logitech', 'Philips', 'Proshop', 'Tweakers', 'Allekabels', 'Kiwi Electronics', 'Tinytronics'];

const CARRIER_NAMES = new Set(Object.values(CARRIERS).map((c) => c.name.toLowerCase()));

/**
 * @param {string} text  pasted email body, links, or a bare tracking number
 * @param {Date} [now]
 * @returns {Array<{code:string, carrier:string, postcode?:string, title:string, retailer?:string,
 *   subject?:string, eta?:string, etaWindow?:string, status:string, source:string}>}
 */
function extractPackages(text, now = new Date()) {
  if (!text || !text.trim()) return [];
  const found = new Map();
  const add = (code, carrier, source, extra = {}) => {
    code = code.toUpperCase().replace(/[\s-]/g, '');
    if (code.length < 8 || !/\d/.test(code)) return;
    const prev = found.get(code);
    if (prev) {
      if (prev.carrier === 'other' && carrier !== 'other') prev.carrier = carrier;
      Object.assign(prev, Object.fromEntries(Object.entries(extra).filter(([, v]) => v)));
      return;
    }
    found.set(code, { code, carrier, source, ...extra });
  };

  const context = contextCarrier(text);

  // 1. Tracking links: most reliable, and PostNL links carry the postcode.
  for (const raw of text.match(/https?:\/\/[^\s<>"'()[\]]+/gi) || []) {
    const hit = parseTrackingUrl(raw.replace(/[.,;:!?]+$/, ''));
    if (hit) add(hit.code, hit.carrier, 'link', { postcode: hit.postcode });
  }

  // Strip URLs so their query strings don't produce junk matches below.
  const plain = text.replace(/https?:\/\/[^\s<>"']+/gi, ' ');

  // 2. Codes with a recognisable shape.
  for (const { carrier, re } of STRONG) {
    for (const m of plain.matchAll(re)) add(m[0], resolve(carrier, m[0], context), 'pattern');
  }

  // 3. Anything sitting right after a "tracking number:" style label.
  for (const m of plain.matchAll(LABEL)) {
    const code = m[1].replace(/-/g, '');
    if (!/\d{4}/.test(code) || /^\d{1,2}[-/.]\d/.test(m[1])) continue;
    add(code, guessCarrier(code, context), 'label');
  }

  // 4. Unlabelled UPS codes are often printed spaced: 1Z 999 AA1 01 2345 6784
  for (const m of plain.matchAll(/\b1Z(?:\s?[0-9A-Z]){16}\b/gi)) add(m[0], 'ups', 'pattern');

  // 5. Bare 14-digit numbers are DPD's format; only trust them when the email mentions DPD.
  if (context === 'dpd') for (const m of plain.matchAll(/\b0\d{13}\b/g)) add(m[0], 'dpd', 'pattern');

  if (!found.size) return [];

  const meta = emailMeta(text, now);
  return [...found.values()].map((p) => ({
    ...p,
    retailer: meta.retailer,
    subject: meta.subject,
    eta: meta.eta,
    etaWindow: meta.etaWindow,
    status: meta.status,
    title: meta.retailer || (p.carrier !== 'other' ? `${CARRIERS[p.carrier].name} parcel` : 'Parcel'),
  }));
}

function resolve(carrier, code, context) {
  if (carrier !== 's10') return carrier;
  return S10_COUNTRY[code.slice(-2).toUpperCase()] || (context ?? 'other');
}

function guessCarrier(code, context = null) {
  code = code.toUpperCase();
  for (const { carrier, re } of STRONG) {
    const m = code.match(new RegExp(`^(?:${re.source.replace(/\\b/g, '')})$`, 'i'));
    if (m) return resolve(carrier, code, context);
  }
  if (context) return context;
  if (/^0\d{13}$/.test(code)) return 'dpd';
  return 'other';
}

function contextCarrier(text) {
  const counts = CARRIER_WORDS
    .map(([id, re]) => [id, (text.match(new RegExp(re.source, re.flags + 'g')) || []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return counts.length ? counts[0][0] : null;
}

function parseTrackingUrl(href) {
  const url = splitUrl(href);
  if (!url) return null;
  const entry = HOSTS.find(([, re]) => re.test(url.hostname));
  if (!entry) return null;
  let carrier = entry[0];

  if (carrier === 'postnl') {
    const m = url.pathname.match(/track-and-trace\/([A-Z0-9]{8,})-([A-Z]{2})-([0-9]{4}\s?[A-Z]{2})?/i);
    if (m) return { carrier, code: m[1], postcode: m[3]?.toUpperCase() };
  }

  // Query string plus SPA-style hash params (#/search?itemCode=…, #nums=…).
  const params = [...queryParams(url.search), ...queryParams(url.hash.replace(/^#\/?[^?=]*\?/, '').replace(/^#/, ''))];

  let code = params.find(([k, v]) => TRACK_PARAMS.test(k) && looksLikeCode(v))?.[1];
  if (!code) code = url.pathname.split('/').filter(Boolean).map(safeDecode).reverse().find(looksLikeCode);
  if (!code) return null;
  code = code.split(',')[0];
  // 17track & friends: carrier comes from the code itself.
  if (carrier === 'other') carrier = guessCarrier(code);
  const postcode = carrier === 'postnl' ? params.find(([k]) => k === 'P' || k === 'p')?.[1] : undefined;
  return { carrier, code, postcode: postcode?.toUpperCase() };
}

// Minimal URL splitting: Google Apps Script (the Gmail inbox job) has no URL/URLSearchParams.
function splitUrl(href) {
  const m = String(href).match(/^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)(\?[^#]*)?(#.*)?$/i);
  return m && { hostname: m[1].toLowerCase(), pathname: m[2] || '/', search: m[3] || '', hash: m[4] || '' };
}

function queryParams(qs) {
  return qs.replace(/^[?#]/, '').split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [safeDecode(kv), ''] : [safeDecode(kv.slice(0, i)), safeDecode(kv.slice(i + 1).replace(/\+/g, ' '))];
  });
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const looksLikeCode = (v) => {
  const s = String(v || '').split(',')[0];
  return /^[A-Z0-9]{8,35}$/i.test(s) && /\d{4}/.test(s) && !/^\d{4}-\d{2}/.test(s);
};

// ---------- email metadata ----------

const MONTHS = {
  jan: 0, januari: 0, january: 0, januar: 0, feb: 1, februari: 1, february: 1, februar: 1,
  mrt: 2, maart: 2, mar: 2, march: 2, märz: 2, maerz: 2, apr: 3, april: 3, mei: 4, may: 4, mai: 4,
  jun: 5, juni: 5, june: 5, jul: 6, juli: 6, july: 6, aug: 7, augustus: 7, august: 7,
  sep: 8, sept: 8, september: 8, okt: 9, oct: 9, oktober: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11, dez: 11, dezember: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function emailMeta(text, now = new Date()) {
  const subject = text.match(/^\s*(?:subject|onderwerp|betreff)\s*:\s*(.+)$/im)?.[1].trim();
  return {
    subject,
    retailer: findRetailer(text, subject),
    ...findEta(text, now),
    status: findStatus(text),
  };
}

function findRetailer(text, subject) {
  // In forwarded mail, the original sender sits after the "Forwarded message" marker.
  const fwd = text.search(/forwarded message|doorgestuurd bericht|weitergeleitete nachricht|begin forwarded|original message|oorspronkelijk bericht/i);
  const scope = fwd >= 0 ? text.slice(fwd) : text;
  const from = scope.match(/^\s*(?:from|van|von)\s*:\s*"?([^"<\n]+?)"?\s*(?:<([^>]+)>)?\s*$/im);
  if (from) {
    let name = from[1].trim();
    if (/@/.test(name)) name = name.split('@')[1].split('.')[0];
    name = name.replace(/\b(no-?reply|noreply|info|klantenservice|customer service|service|orders?|team)\b/gi, '').replace(/[|·\-–]+\s*$/, '').trim();
    if (name && !CARRIER_NAMES.has(name.toLowerCase()) && name.length <= 40) return name;
  }
  const haystack = `${subject || ''}\n${text}`;
  let best = null;
  for (const shop of SHOPS) {
    const i = haystack.toLowerCase().indexOf(shop.toLowerCase());
    if (i >= 0 && (best === null || i < best.i)) {
      // Require a word boundary so "Otto" doesn't match "lotto".
      const before = haystack[i - 1], after = haystack[i + shop.length];
      if ((!before || /[^a-z]/i.test(before)) && (!after || /[^a-z]/i.test(after))) best = { shop, i };
    }
  }
  return best?.shop;
}

const ETA_KEY = /(expected|estimated|delivery|deliver|arriv|verwacht|bezorg|lever|aflever|zustell|voraussichtlich|lieferung|ETA)/gi;

function findEta(text, now) {
  for (const k of text.matchAll(ETA_KEY)) {
    const window = text.slice(k.index, k.index + 140);
    const eta = parseDate(window, now);
    if (eta) {
      const t = window.match(/(\d{1,2}[:.]\d{2})\s*(?:-|–|—|en|and|tot|to|bis|und)\s*(\d{1,2}[:.]\d{2})/i);
      return { eta, etaWindow: t ? `${t[1].replace('.', ':')}–${t[2].replace('.', ':')}` : undefined };
    }
  }
  return {};
}

function parseDate(s, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const build = (y, m, d) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    let date = new Date(y ?? today.getFullYear(), m, d);
    // No year given and the date is long past: it's next year's.
    if (y == null && today - date > 60 * 864e5) date = new Date(today.getFullYear() + 1, m, d);
    return fmt(date);
  };
  let m;
  if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return build(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|e)?\\.?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?`, 'i'))))
    return build(m[3] ? +m[3] : null, MONTHS[m[2].toLowerCase()], +m[1]);
  if ((m = s.match(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?(?:\\s+(\\d{4}))?`, 'i'))))
    return build(m[3] ? +m[3] : null, MONTHS[m[1].toLowerCase()], +m[2]);
  // Numeric day-month; a bare hyphen form needs a year so "Kerkstraat 1-3" isn't 1 March.
  if ((m = s.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/) || s.match(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return build(y, +m[2] - 1, +m[1]);
  }
  if (/\b(today|vandaag|heute)\b/i.test(s)) return fmt(today);
  if (/\b(tomorrow|morgen)\b/i.test(s)) return fmt(new Date(today.getTime() + 864e5));
  return null;
}

function findStatus(text) {
  if (/\b(has been delivered|was delivered|is delivered|delivered on|is bezorgd|is afgeleverd|wurde zugestellt|ist zugestellt)\b/i.test(text)) return 'delivered';
  if (/\b(out for delivery|wordt vandaag bezorgd|vandaag (?:bij je )?bezorgd|komt vandaag|in zustellung|heute zugestellt|bezorger is onderweg)\b/i.test(text)) return 'out';
  return 'shipped';
}
