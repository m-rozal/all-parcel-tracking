# Parcels

All your inbound deliveries in one list, the same on your iPhone, MacBook and Windows laptop. **Forward a shipping email to `littlehelper689@gmail.com`** and the parcel appears within a few minutes, with tracking number, carrier, shop, what's inside and expected delivery. When a parcel should have arrived, the app asks you whether it did. If it didn't, it drafts the complaint email for you.

**Open it:** https://m-rozal.github.io/all-parcel-tracking/ (GitHub Pages serves the `main` branch: repo **Settings → Pages → Deploy from branch → main / root**).

```
 your Gmail ──forward──▶ littlehelper689 Gmail
                              │ every 5 min
                              ▼
                   Apps Script "Parcels inbox"  ── regex parser + Claude reads the email
                              │
                              ▼
                   Google Sheet "Parcels database"  (in littlehelper689's Drive)
                              ▲
                              │ secret link
        iPhone ───── MacBook ───── Windows   (this web app; works offline, syncs when online)
```

Nothing to host or pay for. Everything runs inside the littlehelper689 Google account. The only optional cost is Claude reading emails: a few cents per email, or well under a cent on Haiku.

---

## One-time setup (about 15 minutes)

Use a **private/incognito window** signed in **only** as `littlehelper689@gmail.com`, so Google doesn't install the script in your main account by mistake.

### 1. Create the script

1. Go to [script.google.com](https://script.google.com) → **New project**. Rename it `Parcels inbox`.
2. Replace everything in `Code.gs` with the contents of [`gmail-inbox/Code.gs`](gmail-inbox/Code.gs).
3. Click **+** next to *Files* → **Script**, name it `Parser`, and paste [`gmail-inbox/Parser.gs`](gmail-inbox/Parser.gs).
4. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file**. Back in the editor, open `appsscript.json` and replace it with [`gmail-inbox/appsscript.json`](gmail-inbox/appsscript.json).

### 2. Script properties

**Project Settings** → **Script properties** → **Add script property**:

| Property | Value |
|---|---|
| `ALLOWED_SENDERS` | **Required.** Your main email address (comma-separate several). Mail from any other address is ignored, so strangers can't add parcels. If it's empty, nothing is read. |
| `ANTHROPIC_API_KEY` | *Recommended.* A key from [console.anthropic.com](https://console.anthropic.com). Lets Claude read messy emails, item names and dates written in prose. |
| `CLAUDE_MODEL` | *Optional.* Defaults to `claude-opus-5-5`. `claude-haiku-5-5` is much cheaper and fine for this. |
| `TRACK17_KEY` | *Optional.* A [17TRACK API](https://api.17track.net) key. The script then checks each open parcel with the carrier every hour, so delivery-time changes, "out for delivery" and "delivered" show up even when no email says so. See [Live carrier tracking](#live-carrier-tracking-17track). |

Click **Save script properties**.

### 3. Run setup

Open **`Code.gs`** in the editor. In the toolbar's function menu (next to **Debug**) pick **`setup`** → **Run**. Approve the permissions: Gmail (read and label), Sheets/Drive (the database), external requests (Claude and tracking links), and triggers (the 5-minute timer). Google will warn that the app is unverified. It's your own script, so choose **Advanced → Go to Parcels inbox**.

The execution log shows your **token**. You can find it again later under **Project Settings → Script properties → `TOKEN`**. A Google Sheet called **Parcels database** now exists in littlehelper689's Drive. You can open it at any time to see or fix your data.

### 4. Deploy as a web app

**Deploy** → **New deployment** → gear → **Web app**:
- *Execute as:* **Me (littlehelper689@gmail.com)**
- *Who has access:* **Anyone**

**Deploy** → copy the **Web app URL** (ends in `/exec`). Your database link is:

```
<Web app URL>?token=<token from step 3>
```

> **Treat this link like a password.** Anyone who has it can see and change your parcel list. If it ever leaks, run `rotateToken` in the editor and reconnect your devices.

### 5. Connect your devices

1. On the first device, open the app → **⚙︎ Settings** → paste the database link → **Connect**.
2. Tap **Copy Link for Another Device** and send that link to yourself (Notes, AirDrop, a message to yourself).
3. Open it on each other device. It connects on its own.

**Install it like an app:**
- **iPhone:** open the link from step 2 in **Safari** → **Share** → **Add to Home Screen**. The home-screen app keeps its own storage, so open it once, go to **⚙︎ Settings**, paste the database link and tap **Connect**.
- **MacBook:** Safari → **File → Add to Dock**, or Chrome → ⋮ → **Cast, save and share → Install page as app**.
- **Windows:** Edge → ⋯ → **Apps → Install this site as an app**, or Chrome → ⋮ → **Install**.

### 6. Send it shipping emails

- **By hand:** forward any shipping or tracking email to `littlehelper689@gmail.com`.
- **Automatically:** in your **main** Gmail → ⚙︎ **See all settings** → **Forwarding and POP/IMAP** → **Add a forwarding address** → `littlehelper689@gmail.com`. Google sends a confirmation email to littlehelper689. Open it there and click the link. Then **Filters** → **Create a new filter** → *Has the words*:
  ```
  "track & trace" OR "tracking number" OR "out for delivery" OR shipped OR "has been dispatched" OR verzonden OR onderweg OR bezorgd OR zending OR "je pakket"
  ```
  → **Create filter** → tick **Forward it to** littlehelper689 → **Create filter**.

The script checks littlehelper689 every 5 minutes. It labels mail it used `Parcels/Logged` and mail without a tracking number `Parcels/No tracking`. The app syncs when you open it and every 2 minutes while it's open. Tap the sync pill to sync right away.

### Live carrier tracking (17TRACK)

Emails only tell the app what the shop wrote at the time. To follow the carrier itself (PostNL moving your delivery to tomorrow 10:00–12:30, Japan Post handing over to PostNL, "delivered"):

1. Sign up at [api.17track.net](https://api.17track.net) → **Settings → Security → Access Key** → copy the key.
2. In the script: **Project Settings → Script properties → Add** `TRACK17_KEY` = that key → **Save script properties**.
3. Paste the latest `Code.gs` and run **`setup`** again. It adds an hourly `syncTracking` trigger and keeps your token and Sheet.
4. Optional check: in the function menu pick **`checkTracking`** → **Run**. The log shows 17TRACK's raw answer for your first open parcel.

**Quota:** 17TRACK counts each tracking number you *register*; checking it afterwards is free. The script registers each open parcel once (not delivered, not answered, under 90 days old). The free plan's allowance is small (around 100 numbers; check their pricing page), which is plenty for personal use.

The expanded parcel then shows **Latest update** (e.g. "13 Oct 16:40 · New delivery time: tomorrow between 10:00 and 12:30") and the date, time window and status follow the carrier. Once you've answered "Did it arrive?", the carrier can no longer change that parcel.

---

## Using it

- **The list** groups parcels into *Did it arrive?* · *Today* · *Coming up* · *No date yet* · *Not received* · *Delivered*. The tile on the left shows the day it's expected.
- **Tap a parcel** to expand it: status, carrier, expected delivery, and the tracking number, which links to the carrier's tracking page.
- **"Did it arrive?"** shows up when the carrier says delivered, or when the expected day has passed. **Yes** files it under Delivered. **No** opens a ready-made email to the shop with the tracking details. Add their address, edit if you like, and tap **Open in Mail** (or **Copy Text**). The parcel then waits under *Not received* until you tap **It Arrived**.
- **Add one yourself:** **+** → paste the email, a tracking link or a number, or choose **Enter by Hand**.
- Later emails about the same parcel ("out for delivery", "delivered") update it instead of adding a duplicate. Deleting a parcel removes it on every device, and the email inbox won't bring it back.

Carriers it recognises: PostNL, DHL, DPD, UPS, GLS, FedEx, Amazon (TBA), Budbee, bpost, Royal Mail, USPS, Cainiao/AliExpress, plus any international `XX123456789CC` post code. Anything else opens in 17TRACK.

## Your data and security

- **Where it lives:** one Google Sheet in littlehelper689's Drive. Each device keeps an offline copy and uploads edits made offline once it's back online.
- **Who can reach it:** only someone with the database link (a 122-bit random token). The Sheet itself is private to littlehelper689.
- **Who can add parcels by email:** only mail whose real sender address (or Gmail's auto-forward header) is in `ALLOWED_SENDERS`, matched exactly. Only the inbox is read; Gmail's spam filter removes most forged senders first.
- **Connect links** (`#connect=…`) always ask before switching a device to a database.
- **Claude:** only reads emails that reached littlehelper689 from an allowed sender. It is told to treat the email as data, never as instructions, and a tracking number is saved only if it literally appears in the email.
- **Housekeeping:** deleted parcels are purged after 60 days and received ones after 180 days.
- The repo holds only code.

## Updating the script

After changing `parser.js` or `gmail-inbox/Code.gs`: run `npm run build:gas`, paste the new `Parser.gs`/`Code.gs` into the editor, then **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. The URL and token stay the same.

## Development

No build step for the app. It's plain HTML/CSS/JS modules.

```bash
npm test          # rebuilds Parser.gs, runs parser + backend tests (Apps Script stubbed)
npm run e2e       # two simulated devices against the real Code.gs; writes docs/screenshots/
npm start         # python -m http.server 5173
```

After changing app files, bump `VERSION` in `sw.js` so installed copies refresh.
