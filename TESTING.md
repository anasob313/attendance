# Testing Results, Known Limitations & Implementation Checklist

Run date: 29 October 2026.

The migration was also executed on a real **PostgreSQL 16** server as a non-superuser owner (as on Supabase), with no automatic table grants (Supabase's current default). Checked there: clean run, second run refused, sign-up trigger, RLS through the API roles, a two-connection race (Clock In vs Remote Work on the same day → the second waits and is rejected), and account deletion. **86 automated checks, 86 passed** (re-run after the migration review, 29 Oct 2026).

| Suite | Command | What it runs against | Result |
|---|---|---|---|
| Unit (Vitest) | `npm test` | Pure attendance rules, timezone maths, offline queue, Excel writer | **22 / 22 passed** |
| Database (Node + PGlite) | `npm run test:db` | The real migration on PostgreSQL 17 (WASM) with a stand-in for Supabase's `auth` schema & roles: RLS, RPCs, triggers, reminder scheduling, dispatcher claims | **22 / 22 passed** |
| Push dispatcher (Deno) | `npm run test:push` | Edge Function logic + the real `web-push` library under Deno (payload encrypted, then decrypted as a browser would) | **6 / 6 passed** |
| Browser end-to-end (Playwright) | `npm run test:e2e` | Built PWA in Chromium at iPhone size (393×852, touch), against `e2e/mock-supabase.mjs` — which runs the real SQL in PGlite behind an emulated Supabase Auth/REST API | **36 / 36 passed** |
| Type-check + production build | `npm run build` | TypeScript (app + service worker), Vite, PWA manifest & precache | **passed** |

### What "TESTED" means here — and what it does not

- **TESTED** = covered by the automated suites above, which passed.
- The browser tests use an **emulation** of Supabase Auth and PostgREST (with the real
  schema, RLS and functions underneath). The real hosted Supabase services, real e-mail
  delivery and real Apple push delivery were **not** exercised.
- **No physical iPhone was used.** Every iPhone-specific behaviour is **NOT VERIFIED**.
- **CONFIGURATION REQUIRED** = works only after you complete the matching step in `SETUP.md`.

## Required test cases (section 26)

| # | Case | Status | Evidence |
|---|---|---|---|
| 1 | Exactly 8 working hours | **TESTED** | Unit: 08:00→16:00 = 480 min, GREEN, 0 shortfall; DB stores 480 min |
| 2 | More than 8 hours | **TESTED** | Unit + DB + E2E: 08:00→16:30 = 8h 30m, not capped |
| 3 | Less than 8 hours | **TESTED** | Unit: 08:00→15:30 = 7h 30m, RED, 30 m shortfall; E2E shows "Short" |
| 4 | Notification at Clock In + 7h40 | Scheduling **TESTED** · Delivery on iPhone **NOT VERIFIED** | DB + E2E: `fire_at − clock_in = 460 min`; Deno: exact message text, encryption round-trip |
| 5 | Early Clock Out | **TESTED** | DB + E2E: reminder → `cancelled` |
| 6 | Accidental Clock Out + Undo | **TESTED** | DB + E2E: same session id, original Clock In kept, Clock Out removed, reminder re-scheduled; past reminder → `skipped` (not sent late) |
| 7 | Accidental Remote Work + Undo | **TESTED** (DB) · UI **IMPLEMENTED** | DB: remote → office → remote conversions and undo return the day to Not Recorded |
| 8 | Manual timestamp changes | **TESTED** | DB: edit re-schedules / skips reminder; E2E: manual 08:00–16:30 entry |
| 9 | Forgotten Clock Out | **TESTED** | DB: stays pending, blocks a new Clock In, fixable by setting Clock Out; reports count it as Pending, not completed |
| 10 | Multiple users | **TESTED** | E2E: two accounts in separate browser contexts; same account on a second device sees the same data |
| 11 | User data isolation | **TESTED** | DB: user B cannot read/update/delete A's rows, cannot call dispatcher functions, cannot insert reminders; anonymous gets nothing; E2E: B's history empty |
| 12 | Multi-day leave | **TESTED** | Unit + E2E: Sun–Sat annual leave = 5 working days; DB: overlap blocked, REPLACE splits leave |
| 13 | Public holidays | **TESTED** | Unit: multi-day holiday (teal), not counted as missing; DB: create/edit/delete |
| 14 | Weekend handling | **TESTED** | Unit: Fri/Sat GRAY, weekend work adds hours but no shortfall |
| 15 | Overnight attendance | **TESTED** | Unit + DB: Thu 22:00→Fri 06:00 = 8h on Thursday; overlapping session rejected |
| 16 | Monthly reports | **TESTED** | Unit: every summary figure for a constructed month; future days never counted; E2E renders |
| 17 | Excel export | **TESTED** | Unit + E2E download `Attendance_Report_October_2026.xlsx`; opened with openpyxl and LibreOffice — status colours, summary sheet, frozen header |
| 18 | Offline synchronization | **TESTED** in Chromium · iPhone **NOT VERIFIED** | E2E: offline Clock In → "Saved locally", nothing on server, app reopens offline with timer running, back online → "Synced", server keeps the original tap time |
| 19 | Duplicate prevention | **TESTED** | DB: repeated Clock In / Clock Out / Remote Work are idempotent; queue replay after lost response adds nothing; one active session enforced by a unique index |
| 20 | Multiple registered devices | Logic **TESTED** · real devices **NOT VERIFIED** | Deno: sent to every device, expired (404/410) removed; DB: per-device rows, device moves to the account that signs in on it |
| 21 | Notification cancellation | **TESTED** | DB + E2E |
| 22 | Notification rescheduling | **TESTED** | DB: Clock In edits, lead-time and duration changes; E2E: lead 30 → `fire_at = clock_in + 450 min` for that user only |
| 23 | Account deletion | **TESTED** (emulated auth) · on real Supabase **NOT VERIFIED** | DB + E2E: all of the user's rows and auth record removed; other user intact |
| 24 | iPhone Home Screen installation | **NOT VERIFIED** | Manifest, icons, `apple-mobile-web-app-*` tags and service worker built; offline start verified in Chromium |
| 25 | Push on a locked iPhone | **NOT VERIFIED** | Requires a physical iPhone + deployed backend |

### Verify on your iPhone after deployment (10 minutes)

1. Install from Safari → open from the icon → sign in.
2. Settings → Enable notifications → Allow → **Send test** (app open), then lock the phone and send a test from another device.
3. Real 7h40 check without waiting: Clock In, then in Supabase SQL Editor run
   `update reminders set fire_at = now() + interval '2 minutes' where status = 'scheduled';`
   and lock the phone. The reminder should arrive within ~1–2 minutes.
4. Turn on Airplane Mode → Clock Out → "Saved locally" → turn it off → reopen → "Synced".

## Configuration required

| Item | Where |
|---|---|
| Supabase project + run migration | SETUP.md §1 |
| Custom SMTP for sign-up / password e-mails | SETUP.md §1 |
| VAPID keys | SETUP.md §2 |
| Edge Function deploy + secrets | SETUP.md §3 |
| Every-minute scheduler (`cron.sql`) | SETUP.md §4 |
| Hosting + `VITE_*` variables | SETUP.md §5 |
| Optional keep-alive | SETUP.md §7 |

## Known limitations

**Notifications**
- Delivery is not guaranteed to the second: the scheduler runs once a minute, then Apple's push service delivers. Expect the reminder within roughly a minute of Clock In + 7h40.
- Each push carries a TTL that ends at the 8-hour mark, so a phone that is offline at reminder time does not get a stale reminder later.
- iPhone needs iOS/iPadOS 16.4+, the Home Screen app, and permission per device. Focus, Do Not Disturb and Low Power modes can hide or delay it. Deleting the Home Screen app removes its subscription.
- If a Clock In made offline only reaches the server after its reminder time, no reminder is sent (no late reminders, by design).

**Offline**
- Offline-capable: Clock In, Clock Out, Undo Clock Out, Remote Work on/off. Manual edits, leave, settings and account changes need a connection and are disabled offline with an explanation.
- iOS has no background sync for web apps: queued changes sync when the app is opened or brought to the foreground with a connection.
- Times come from the device clock. The server rejects times more than 5 minutes in the future.

**Rules chosen**
- One office session per day (a mistaken Clock Out is fixed with Undo, not a second session). A session is limited to 24 hours.
- An unfinished (forgotten) session must be completed or deleted before the next Clock In — this is what prevents overlapping sessions.
- A day's working target is stored with each session, so changing the 8 h setting does not recolour history unless you choose **Recalculate**. Changing working days or timezone affects how days without records are classified.
- Weekend sessions count toward hours but create no shortfall and are not "Short Working Days".
- Leave that spans a weekend shows the weekend as Weekend; only working days are counted.

**Platform / free tier**
- Free Supabase projects pause after ~7 days without activity (restorable, no data loss) and have no automatic backups — use **Export all records** periodically.
- Password-reset and confirmation links open in Safari, not in the Home Screen app; afterwards sign in inside the app.
- Supabase's built-in e-mail only reaches your Supabase team members; custom SMTP is needed for everyone else.
- Free tiers can change; nothing here is guaranteed to remain free.

## Final implementation checklist (section 27)

| # | Deliverable | Status | Location |
|---|---|---|---|
| 1 | Runnable source code | IMPLEMENTED · builds | `src/`, `supabase/`, `package.json` |
| 2 | Database schema | IMPLEMENTED · TESTED | `supabase/migrations/20261029000001_schema.sql` |
| 3 | Authentication (sign up, log in, log out, forgot/reset password, persistent login) | IMPLEMENTED · TESTED with emulated auth (sign up, log in, wrong password, persistent login across reloads, log out, second device) · confirmation / reset e-mails NOT VERIFIED (need SMTP) | `src/pages/Auth.tsx`, `src/state/auth.tsx` |
| 4 | Row Level Security | IMPLEMENTED · TESTED | migration (policies + revokes) |
| 5 | Attendance calculation | IMPLEMENTED · TESTED | `src/lib/attendance.ts`, `src/lib/time.ts` |
| 6 | Remote Work | IMPLEMENTED · TESTED | dashboard, `DayEditor.tsx`, `set_remote` / `delete_remote` |
| 7 | Leave management | IMPLEMENTED · TESTED | `src/pages/Leave.tsx`, `save_leave` |
| 8 | Manual editing | IMPLEMENTED · TESTED | `DayEditor.tsx`, `SessionForm`, `upsert_session` |
| 9 | Calendar | IMPLEMENTED · TESTED (renders, day editor) | `src/pages/Calendar.tsx` |
| 10 | Monthly reports | IMPLEMENTED · TESTED | `src/pages/Reports.tsx` |
| 11 | Excel export (.xlsx) | IMPLEMENTED · TESTED | `src/lib/excel.ts` |
| 12 | Push infrastructure | IMPLEMENTED · logic TESTED · iPhone delivery NOT VERIFIED · CONFIGURATION REQUIRED | `supabase/functions/send-reminders/`, `supabase/setup/cron.sql`, `src/lib/push.ts`, `src/sw.ts` |
| 13 | Offline synchronization | IMPLEMENTED · TESTED (Chromium) | `src/lib/sync.ts`, `src/state/data.tsx` |
| 14 | PWA configuration | IMPLEMENTED · TESTED (Chromium) · iPhone NOT VERIFIED | `vite.config.ts`, `index.html`, `public/icons/` |
| 15 | Deployment instructions | DONE | `SETUP.md` §1–5 |
| 16 | iPhone installation instructions | DONE | `SETUP.md` §6, in-app *Install on iPhone* |
| 17 | Free-service configuration guide | DONE | `SETUP.md` §0, §7 |
| 18 | Testing results | DONE | this file, `e2e/last-results.json` |
| 19 | Known limitations | DONE | this file |
| 20 | Final checklist | DONE | this table |
