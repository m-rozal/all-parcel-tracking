import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPackages, parseTrackingUrl, parseDate, trackingUrl } from '../parser.js';

const NOW = new Date(2026, 9, 11); // 11 Oct 2026

const one = (text) => {
  const r = extractPackages(text, NOW);
  assert.equal(r.length, 1, `expected 1 package, got ${JSON.stringify(r)}`);
  return r[0];
};

test('PostNL Dutch email with track & trace code and link', () => {
  const p = one(`Van: Coolblue <noreply@coolblue.nl>
Onderwerp: Je bestelling is onderweg
Hoi Mateusz, je pakket wordt verwacht op dinsdag 13 oktober tussen 14:00 en 16:00.
Track & Trace code: 3SCBLU123456789
Volg je pakket: https://jouw.postnl.nl/track-and-trace/3SCBLU123456789-NL-5612AB`);
  assert.equal(p.code, '3SCBLU123456789');
  assert.equal(p.carrier, 'postnl');
  assert.equal(p.postcode, '5612AB');
  assert.equal(p.retailer, 'Coolblue');
  assert.equal(p.eta, '2026-10-13');
  assert.equal(p.etaWindow, '14:00–16:00');
  assert.equal(trackingUrl(p), 'https://jouw.postnl.nl/track-and-trace/3SCBLU123456789-NL-5612AB');
});

test('DHL eCommerce code from bol.com', () => {
  const p = one(`From: bol.com <noreply@bol.com>
Subject: Je pakket komt eraan
Je bestelling wordt bezorgd door DHL. Zendingnummer: JVGL06240512345678901
Verwachte levering: 14-10-2026`);
  assert.equal(p.carrier, 'dhl');
  assert.equal(p.code, 'JVGL06240512345678901');
  assert.equal(p.retailer, 'bol.com');
  assert.equal(p.eta, '2026-10-14');
});

test('UPS spaced number, English', () => {
  const p = one(`Your order has shipped!
Tracking number: 1Z 999 AA1 01 2345 6784
Estimated delivery: October 15, 2026`);
  assert.equal(p.carrier, 'ups');
  assert.equal(p.code, '1Z999AA10123456784');
  assert.equal(p.eta, '2026-10-15');
});

test('DPD 14-digit number only trusted with DPD context', () => {
  assert.equal(one('Your DPD parcel number is 05212345678901').carrier, 'dpd');
  assert.equal(extractPackages('Call us on 05212345678901', NOW).length, 0);
});

test('Amazon TBA and AliExpress S10 in one paste', () => {
  const r = extractPackages('TBA301234567890 and also LP00123456789012 plus RR123456789NL', NOW);
  assert.deepEqual(r.map((p) => p.carrier).sort(), ['amazon', 'cainiao', 'postnl']);
});

test('order numbers and dates are not mistaken for tracking codes', () => {
  assert.deepEqual(extractPackages(`Ordernummer: 123456789
Besteld op 10-10-2026, totaal € 49.95
Bezorgadres: Kerkstraat 1-3, 5612 AB Eindhoven`, NOW), []);
});

test('bare tracking link only', () => {
  const p = one('https://www.dhl.com/nl-nl/home/tracking.html?tracking-id=JJD0099999999&submit=1');
  assert.equal(p.carrier, 'dhl');
  assert.equal(p.code, 'JJD0099999999');
});

test('URL parsing for several carriers', () => {
  assert.deepEqual(parseTrackingUrl('https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784'),
    { carrier: 'ups', code: '1Z999AA10123456784', postcode: undefined });
  assert.equal(parseTrackingUrl('https://tracking.dpd.de/status/nl_NL/parcel/05212345678901').code, '05212345678901');
  assert.equal(parseTrackingUrl('https://gls-group.com/NL/nl/pakket-volgen?match=12345678901').carrier, 'gls');
  assert.equal(parseTrackingUrl('https://t.17track.net/en#nums=RR123456789DE').carrier, 'dhl');
  assert.equal(parseTrackingUrl('https://www.example.com/track?id=12345678'), null);
});

test('status detection', () => {
  assert.equal(one('Je pakket is bezorgd. Track & Trace: 3SABCD1234567').status, 'delivered');
  assert.equal(one('Out for delivery! Tracking: 1Z999AA10123456784').status, 'out');
  assert.equal(one('Verzonden. Barcode 3SABCD1234567').status, 'shipped');
});

test('date parsing', () => {
  assert.equal(parseDate('vandaag', NOW), '2026-10-11');
  assert.equal(parseDate('arrives tomorrow', NOW), '2026-10-12');
  assert.equal(parseDate('voraussichtlich am 2. November', NOW), '2026-11-02');
  assert.equal(parseDate('expected 3 jan', NOW), '2027-01-03');
});

test('empty and junk input', () => {
  assert.deepEqual(extractPackages('', NOW), []);
  assert.deepEqual(extractPackages('Hello, thanks for your order!', NOW), []);
});
