# Parcels

All your inbound deliveries in one place. Copy a shipping email, tap **Paste shipping email**, and the app picks out the tracking number, carrier, shop and expected delivery date.

**Open it:** https://m-rozal.github.io/parcel_tracker/

## Install on iPhone

1. Open the link above in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Launch it from the home screen icon. It works offline.

## Adding a delivery

- **From an email:** in Mail, select all text in the shipping email and copy it (or copy just the tracking link). Open Parcels → **Paste shipping email**. Check the found packages → **Add to tracker**.
- **By hand:** tap **+** and type the tracking number.
- **Updates:** paste a later email for the same parcel ("out for delivery", "delivered") and the existing card updates instead of duplicating.

Each card links straight to the carrier's tracking page (and to 17TRACK, which handles almost any carrier).

### Carriers it recognises

PostNL, DHL, DPD, UPS, GLS, FedEx, Amazon (TBA), Budbee, bpost, Royal Mail, USPS, Cainiao/AliExpress, plus any international `XX123456789CC` post code. Unknown formats still work; they just open in 17TRACK.

Set your postcode in **Settings** so PostNL links open the parcel directly.

## Your data

Everything stays in your browser's local storage. No account, no server; the repo holds only code. Note that on iPhone the home-screen app and Safari have **separate** storage. To move parcels between devices, use **Settings → Copy all data** on one and **Import** on the other.

## Optional: iOS Shortcut

To send selected text from any app's share sheet: create a Shortcut that receives **Text** from the Share Sheet and runs **Open URL** with
`https://m-rozal.github.io/parcel_tracker/?text=[Shortcut Input]` (URL-encode the input first).
This opens in Safari, which has its own storage separate from the home-screen app, so pasting inside the installed app is usually the better option.

## Development

No build step. It's plain HTML/CSS/JS modules.

```bash
npm test          # parser tests (node --test)
python -m http.server 5173
```

After changing app files, bump `VERSION` in `sw.js` so installed copies refresh.
