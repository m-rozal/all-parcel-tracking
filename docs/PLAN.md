# Parcels v2 plan

## Decisions (agreed with owner, 2026-10-13)

| Topic | Decision |
|---|---|
| Shared database | Google Sheet "Parcels database" in the `littlehelper689@gmail.com` Drive, owned by an Apps Script web app in that account. Guarded by a 122-bit token in the link. |
| Email reader | The same Apps Script checks littlehelper's inbox every 5 min. Regex parser plus Claude (Anthropic API key in Script Properties). Always on, no chat session needed. |
| What syncs | Everything: emailed parcels, manual adds, edits, status, "did it arrive" answers, deletions. The Sheet is the source of truth. |
| "Did it arrive?" | Asked when the carrier says delivered **or** the expected day has passed, until answered. |
| Not arrived | The app fills in an email template the owner can edit, then opens it in their own mail app (`mailto:`) or copies it. |
| Region | Netherlands: PostNL, DHL, DPD, etc. Dutch and English emails. |
| Setup state | littlehelper689 exists, nothing installed yet. |

## Architecture

```
main Gmail ──forward/filter──▶ littlehelper689 Gmail
                                   │  (time trigger, 5 min)
                                   ▼
                          Apps Script "Parcels inbox"
                    regex parser + Claude ─▶ Google Sheet (rows = parcels)
                                   ▲
              GET list / POST sync │  token in URL
                                   │
   iPhone PWA ── MacBook browser ── Windows browser   (same GitHub Pages app)
   localStorage = offline cache + outbox of unsynced edits
```

### Record (one Sheet row, one JSON object)

| Field | Type | Notes |
|---|---|---|
| `id` | string | client `uid()` or server `em-<code>-<ts>` |
| `code` | string | tracking number, upper-case, no spaces |
| `carrier` | string | key of `CARRIERS` in `parser.js` |
| `title` | string | shop or name |
| `subject` | string | what's inside |
| `retailer` | string | shop |
| `eta` | `YYYY-MM-DD` or `''` | stored as plain text (no Sheets date coercion) |
| `etaWindow` | string | `14:00–16:00` |
| `postcode` | string | for PostNL links |
| `note` | string | |
| `status` | `shipped` · `out` · `delivered` | carrier view |
| `confirmed` | `''` · `yes` · `no` | owner's answer to "did it arrive?" |
| `source` | `email` · `paste` · `manual` | |
| `createdAt`, `updatedAt`, `deliveredAt` | ms epoch / `''` | |
| `deleted` | boolean | tombstone so other devices drop it |

### API (Apps Script web app)

- `GET  <exec>?token=T` → `{ ok, packages: Record[] (incl. tombstones), syncedAt }`
- `POST <exec>?token=T`, body `{"changes": Record[]}` sent as `text/plain` (no CORS preflight) → merge, then same response as GET.
- Merge rule (POST): match by `id`; otherwise match a non-deleted row by `code`. Overwrite when `incoming.updatedAt >= stored.updatedAt` (last write wins, keep stored `id`). Insert if no match.
- Email rule: match a row by `code`. Tombstoned → ignore (the owner deleted it, don't bring it back). Live → status only moves forward and only while `confirmed` is empty. Fill blank fields, take a new `eta`, bump `updatedAt`. Insert if no match.
- Pruning: tombstones older than 60 days, confirmed-`yes` rows older than 180 days.
- `LockService` around every write.

### Client sync

1. Each edit sets `updatedAt = now`, saves locally and queues the `id` in `outbox`.
2. `sync()` POSTs the outbox records (GET when the outbox is empty), replaces local `packages` with the server list, and keeps any record edited after the request started.
3. Sync runs on launch, on focus, every 2 min while visible, and 1.5 s after each edit (debounced).
4. Offline: edits stay in the outbox. The sync pill shows "Offline · 2 unsynced".
5. Adding another device: Settings → "Copy link for another device" gives `https://…/#connect=<url-encoded exec link>`. The hash never reaches a server.

## UI (Apple HIG, web)

Thesis: *one calm list that answers "what's arriving, when, and what needs me?"*

- **Structure:** a single screen. Large title "Parcels" and a toolbar on the right (sync status, Add, Settings). Inset grouped list sections (iOS Settings style):
  1. **Needs your answer**: "Did it arrive?" with inline **Yes** / **No**. Feedback stays in the page, not in alerts (`alerts.md › Best practices`).
  2. **Today**, **Coming up**, **No date yet**
  3. **Problems**: answered "No". Actions: "Draft email" and "It arrived after all".
  4. **Delivered**: collapsed disclosure, history.
- **Expandable row** (`disclosure-controls.md`): the collapsed row shows the date tile, title, "Carrier · status" and a chevron. Expanded it shows Status (3-step track), Carrier, Expected delivery, Tracking number as a link to the carrier site, then Copy, Edit and Delete. A `button[aria-expanded]` controls a region, and open state survives re-renders.
- **Signature element:** a calendar-style **date tile** at the row's leading edge (`TUE` / `14`, or `TODAY`), tinted by state. The rest stays quiet.
- **Tokens:** system font stack (SF on Apple, Segoe UI on Windows). Body 17 px, subhead 15, footnote 13, large title 34 bold. Tracking numbers in `ui-monospace`. Dark-only warm palette with a yellow-orange accent (`#ffb224`), the owner's choice; `dark-mode.md › Best practices` allows a dark-only appearance. Text contrast-checked to ≥4.5:1. Carrier brand colours are dropped so that colour only means status (`color.md`: one colour, one meaning).
- **Motion:** row expand only (grid-rows 0fr→1fr, 200 ms). Off under `prefers-reduced-motion`.
- **Targets:** ≥44×44 px controls, visible `:focus-visible`, every icon button labelled.

## Work split

| Track | Owner | Files |
|---|---|---|
| Backend: Sheet store, `doPost` sync, email upsert, tests | sub-agent (parallel) | `gmail-inbox/Code.gs`, `gmail-inbox/appsscript.json`, `tests/inbox.test.mjs` |
| Front end: redesign, expandable rows, arrival flow, sync client | lead | `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest` |
| Setup guide (littlehelper689 step by step) | lead | `README.md` |
| Validation: Playwright screenshots (phone and desktop, light and dark), checked against requirements by an independent agent | lead + reviewer agent | `docs/screenshots/` |

## Quality bar (definition of done)

- [ ] `npm test` green, including new sync and merge tests
- [ ] Every requirement has a screenshot: pending list, expanded row with all 4 fields and a working link, the "Did it arrive?" prompt, the drafted email, the setup/connect screen
- [ ] Layout works at 375 px and 1280 px, in light and dark mode
- [ ] Text contrast ≥4.5:1 (computed, not eyeballed)
- [ ] Keyboard-only: rows expand with Enter/Space, focus is visible
- [ ] Offline edit followed by reconnect syncs with no data loss (unit-tested merge)
- [ ] `sw.js` VERSION bumped

## Risks / open questions

- **Token = password.** Anyone with the link can read and edit the list. Mitigations: 122-bit random token, private Sheet, `ALLOWED_SENDERS` so strangers can't inject parcels, and a way to rotate the token (`rotateToken()`).
- **Last write wins** uses device clocks. Two devices editing the same parcel within seconds is unlikely for one person. Accepted.
- **Apps Script quotas** (consumer account): about 20k URL fetches a day and 90 min of trigger runtime a day. A 5-minute trigger with light mail stays far below both.
- **Claude cost**: a few cents per email on Opus 5.5. Set `CLAUDE_MODEL=claude-haiku-5-5` for well under a cent.
- **GitHub Pages** serves the default branch, so changes go live only after merge.
