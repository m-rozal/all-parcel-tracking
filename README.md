# Parcels

All your inbound deliveries in one place. **Forward a shipping email to your Parcels Gmail** and it shows up in the app within a few minutes: tracking number, carrier, shop, what's inside and when it arrives. You can also paste emails into the app directly.

**Open it:** https://m-rozal.github.io/parcel_tracker/

```
 you forward ──▶ parcels Gmail ──▶ Apps Script (every 5 min) ──▶ regex parser + Claude ──▶ web app JSON ──▶ Parcels app
                                     runs in that Google account, free
```

## Install on iPhone

1. Open the link above in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Launch it from the home screen icon. It works offline.

## Set up the email inbox (one-time, ~10 min)

The inbox is a small Google Apps Script that lives inside a dedicated Gmail account. It runs on Google's servers for free. You don't need to host anything.

1. **Create a new Gmail account** for parcels only, e.g. `yourname.parcels@gmail.com`.
2. Signed in as that account, open [script.google.com](https://script.google.com) → **New project**. Name it `Parcels inbox`.
3. Replace the contents of `Code.gs` with [`gmail-inbox/Code.gs`](gmail-inbox/Code.gs).
   Click **+** → **Script**, name it `Parser`, and paste [`gmail-inbox/Parser.gs`](gmail-inbox/Parser.gs).
4. **Project Settings** (gear icon) → **Script properties** → add:
   | Property | Value |
   |---|---|
   | `ALLOWED_SENDERS` | your normal email address(es), comma-separated. Mail from anyone else is ignored. |
   | `ANTHROPIC_API_KEY` | *optional.* A key from [console.anthropic.com](https://console.anthropic.com). Turns on Claude reading. |
   | `CLAUDE_MODEL` | *optional.* Defaults to `claude-opus-5-5`; `claude-haiku-5-5` is much cheaper. |
5. Back in the editor, pick the **`setup`** function in the toolbar → **Run**. Approve the permissions (read/label Gmail, fetch URLs, run on a timer). The execution log prints your **token**.
6. **Deploy** → **New deployment** → type **Web app** → *Execute as:* **Me**, *Who has access:* **Anyone** → **Deploy**. Copy the web app URL.
7. In the Parcels app: **Settings → Email inbox**. Paste `<web app URL>?token=<your token>` → **Connect & check**.

Done. Forward any shipping email to the parcels address. The app checks when you open it and every 5 minutes while it's open. You can also tap **↻ Inbox** to check right away.

**Hands-free:** in your main Gmail, add the parcels address under *Settings → Forwarding*, then make a filter (e.g. `"track & trace" OR "tracking number" OR verzonden OR "out for delivery"`) that forwards matches there.

### What Claude adds

Without an API key, the regex parser handles the common carriers and formats, and it follows "Track your parcel" buttons through shop click-trackers. With a key, Claude also reads each email. It picks up numbers in unusual layouts, works out what's inside ("Sony WH-1000XM6 headphones") and reads delivery dates written in prose. Claude never invents numbers: one is only logged if it literally appears in the email or its links. Rough cost: a few cents per email on Opus 5.5, well under a cent on Haiku 5.5.

### Updating the inbox script

After changing `parser.js`, run `npm run build:gas`, paste the new `Parser.gs`/`Code.gs` into the editor, then **Deploy → Manage deployments → edit → New version**. The URL stays the same.

## Adding a delivery by hand

- **Paste:** copy a shipping email or tracking link → **Paste shipping email** → **Add to tracker**.
- **Type:** tap **+** and enter the tracking number.
- **Updates:** a later email for the same parcel ("out for delivery", "delivered") updates the existing card instead of duplicating it.

Carriers it recognises: PostNL, DHL, DPD, UPS, GLS, FedEx, Amazon (TBA), Budbee, bpost, Royal Mail, USPS, Cainiao/AliExpress, plus any international `XX123456789CC` post code. Anything else opens in 17TRACK.

## Your data

- The app keeps parcels in your browser's local storage.
- The inbox keeps them in its own Script Properties and drops them after 60 days.
- The repo holds only code.
- Treat the inbox link like a password: anyone who has it can see your tracking list.
- On iPhone, the home-screen app and Safari have **separate** storage, so connect the inbox inside the installed app. Every device you connect gets the same email parcels.

## Development

No build step for the app. It's plain HTML/CSS/JS modules.

```bash
npm test          # rebuilds Parser.gs, runs parser + inbox tests (Apps Script stubbed)
npm start         # python -m http.server 5173
```

After changing app files, bump `VERSION` in `sw.js` so installed copies refresh.
