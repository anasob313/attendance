# Project State — Attendance PWA (بصمة الدوام)

Single source of truth for anyone (human or AI) continuing this project.
Update this file with every change. Last updated: **2026-10-31**.

## Production

| Item | Value |
|---|---|
| Supabase project | `attendance-pwa` · ref `jhofnqvnjbxobjisfukx` · region eu-west-1 · PostgreSQL 17 · Free plan |
| API URL | `https://jhofnqvnjbxobjisfukx.supabase.co` |
| Frontend key | publishable key `sb_publishable_…` (public; committed in `.env.production`) |
| Live app URL | **https://anasob313.github.io/attendance/** |
| Hosting | GitHub Pages from branch `gh-pages`; `.github/workflows/deploy.yml` tests, builds and publishes on every push to `main` |
| Source repository | https://github.com/anasob313/attendance (public; branch `main`) — GitHub user `anasob313`; Claude GitHub App installed on this repo only |

### Backend status (verified 2026-10-30)

| Component | Status |
|---|---|
| Schema migration `20261029000001_schema.sql` (rev 2) | ✅ applied — 7 tables with RLS, 16 public RPCs, 17 private helpers |
| Migration `20261031000001_oauth_profile_name.sql` | ✅ applied — new accounts take the profile name from `full_name` or `name` (Google) |
| Sign-up trigger `attendance_on_auth_user_created` | ✅ present; owner account exists and is confirmed |
| Edge Function `send-reminders` | ✅ v6 deployed (verify_jwt = false); secrets cleaned on read (`config.ts`) |
| Function secrets | ✅ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET — valid, key pair matches (verified by the function) |
| Vault secrets | ✅ `attendance_project_url`, `attendance_cron_secret` |
| pg_cron job `send-attendance-reminders` (every minute) | ✅ running, function returns 200 |
| Housekeeping job | ⏳ **pending owner approval** — `supabase/migrations/PENDING_20261030000002_housekeeping.sql` |
| Edge Function `auth-admin` | 🗑️ retired (v3 = empty stub returning 410, verify_jwt on, no secrets). Owner may delete it in the dashboard; the connector has no delete tool |
| Google sign-in (Supabase provider `google`) | ✅ enabled 2026-11-01 (Google Auth Platform project "Attendance", In production, External; Web client "Attendance web"). Verified: /authorize → accounts.google.com with redirect_uri `…supabase.co/auth/v1/callback`, scopes `email profile`. Real iPhone sign-in: ⏳ owner test |
| Auth Site URL / redirect URLs | ✅ Site URL `https://anasob313.github.io/attendance/`, redirect `https://anasob313.github.io/attendance/**` (verified 2026-11-01 via `auth.flow_state.referrer`: allowed paths kept, unknown hosts fall back to the Site URL) |
| Custom SMTP | ❌ not used (decision 2026-10-31) — no email sender without buying a domain |

### Secrets — where they live (never in this repository)

| Secret | Location |
|---|---|
| VAPID private key, CRON_SECRET, VAPID_SUBJECT | Supabase → Edge Functions → Secrets |
| CRON_SECRET copy, project URL | Supabase Vault |
| VAPID public key, Supabase URL, publishable key (all public) | `.env.production` in the repository |

The VAPID key pair must never be regenerated: every device would have to re-enable notifications.

## Authentication (decision 2026-10-31)

- **New users: "Continue with Google" only** (owner approved). Google verifies the email and handles account recovery; no confirmation/reset emails are needed. Free, no domain.
- **Existing e-mail accounts** (the owner's) keep signing in with e-mail + password. Their password-reset email still works through Supabase's built-in mailer, which only delivers to members of the Supabase organization (the owner).
- E-mail + password **sign-up is hidden**, not removed: build flag `VITE_EMAIL_SIGNUP=true` re-enables it (used by the browser tests). Turn it on only after a real email sender exists.
- Email verification is **not** disabled (`mailer_autoconfirm = false`).
- Alternatives evaluated: Gmail SMTP (owner could not create a dedicated Gmail), Brevo/Mailjet/SMTP2GO (sender address shown to users, deliverability issues without own domain), Resend (needs own domain), Sign in with Apple (needs Apple Developer Program, $99/yr). Cheapest email path later: a domain (~$10/yr) + Resend free tier.
- Google consent-screen "user support email" and developer contact = `attendance-app-support@googlegroups.com` (Google Group), so the owner's personal address is not shown.
- Public pages required by Google (static files in `public/`, excluded from the app's offline navigation fallback in `src/sw.ts`):
  - Home page: https://anasob313.github.io/attendance/home/
  - Privacy Policy: https://anasob313.github.io/attendance/privacy/
  - Terms of Service: https://anasob313.github.io/attendance/terms/
  - Linked from every sign-in screen. **Keep the Privacy Policy accurate whenever data handling changes.**
- Google Auth Platform authorized domains: `anasob313.github.io` and `jhofnqvnjbxobjisfukx.supabase.co` (both `github.io` and `supabase.co` are on the Public Suffix List, so these are the registrable domains). Brand verification not requested (no logo) — not needed for the basic openid/email/profile scopes.
- Google OAuth client redirect URI: `https://jhofnqvnjbxobjisfukx.supabase.co/auth/v1/callback`. Client ID/secret live only in Supabase (Auth → Providers → Google).

## Accounts & go-live (2026-11-01)

- Owner's **primary account: Google sign-in** (created 2026-11-01, first working day 2026-11-01). Settings: 8 h day, reminder 20 min before (Clock In + 7h40), working days Sun–Thu, Asia/Riyadh.
- Owner's original **e-mail account is kept unchanged** (no records; nothing deleted). His iPhone's push registration moved to the Google account when he signed in there — by design, one device belongs to the account signed in on it.
- Verified 2026-11-01 (read-only): 2 accounts, each with its own profile + settings; RLS on all 7 tables; simulated as each user, only own rows visible; `anon` has no table privileges; cron runs every minute (60/60 succeeded in the last hour, send-reminders HTTP 200); iPhone push subscription (`web.push.apple.com`) registered to the Google account.
- Security advisor warnings are known and accepted: `pg_net` in `public` (Supabase default), `delete_my_account` / `register_push_subscription` are SECURITY DEFINER by design (both use `auth.uid()` only), `rls_auto_enable` is Supabase's own event-trigger function (not callable as RPC), leaked-password protection is a paid-plan feature.
- **Ready to share**: send people https://anasob313.github.io/attendance/ — they sign up with Google (steps in README "Using the app").
- Free-plan capacity: up to 50,000 monthly active users on Supabase Free; the project pauses after 7 days without activity (the keep-alive workflow pings it every 2 days).

## How to make a change (workflow for future sessions)

Requirements: the **Supabase** connector and a linked **GitHub** account in the session.

1. Attach the repo (`add_repo anasob313/attendance`, push access), clone it, read this file and `README.md`.
   Note: this Claude GitHub access cannot change repo settings, Actions variables or the Pages API — only push.
2. Change the code. Keep business rules in `src/lib/attendance.ts` / the SQL.
3. Test: `npm ci && npm test && npm run test:db` (+ `npm run test:e2e`, `npm run test:push` with Deno).
4. Database change → new file `supabase/migrations/<timestamp>_<name>.sql`, apply with the Supabase connector (`apply_migration`), then run the security advisor.
5. Edge Function change → deploy `index.ts`, `dispatch.ts`, `config.ts` together with `verify_jwt = false`.
6. Commit and push to `main` → GitHub Actions tests, builds and redeploys to the same URL.
   Check the result via `gh api repos/anasob313/attendance/commits/<sha>/check-runs` (job `deploy`).
   Fallback if Actions fails: `BASE_PATH=/attendance/ npm run build`, copy index.html→404.html, add .nojekyll, force-push `dist/` to `gh-pages`.
7. Update this file (status + change log).

Roll back: `git revert <commit>` and push (frontend). Database changes need a new forward migration.

## Known limitations

- Google sign-in inside the iPhone Home Screen app: verified by the owner on his iPhone (2026-11-01) — returns to the app.
- Free Supabase projects pause after ~7 days without activity (daily use prevents it; `keepalive.yml` pings every 2 days). No automatic backups on Free — use **Profile → Export all records**.
- GitHub disables scheduled workflows after 60 days without commits (re-enable in Actions).
- Push needs iOS 16.4+, the Home Screen app, and permission per device. Delivery is typically within ~1 minute of Clock In + 7h40.

## Change log

| Date | Change |
|---|---|
| 2026-10-29 | Initial build; migration reviewed and corrected (rev 2: explicit grants, private schema, per-user lock). |
| 2026-10-30 | Owner applied migration, deployed function, set secrets. Claude: enabled pg_cron/pg_net, stored Vault secrets, scheduled reminders; function v6 repairs pasted secrets (the stored public key had been damaged in pasting) and reports config problems instead of crashing; app made sub-path aware for GitHub Pages; deploy workflow added. |
| 2026-10-30 | Repository created (anasob313/attendance) and code pushed; site published to GitHub Pages via `gh-pages`; workflow switched to gh-pages publishing; public build values moved to `.env.production`. |
| 2026-10-31 | Email plan (Gmail SMTP) dropped; added "Continue with Google"; new-user email sign-up hidden (owner approved); profile-name migration applied; temporary `auth-admin` function retired (stub) and its code removed; browser tests extended (email-link handling, Google flow) — 50/50 pass. |
| 2026-11-01 | **Owner confirmation (17:57):** the closed-app test notification appeared on the lock screen. The 16:46 reminder **never appeared and is not in Notification Center**. Root cause of the 16:46 loss: **unknown** — server and Apple handled it correctly (accepted, 2xx); receipts did not exist yet, so the device side cannot be reconstructed. |
| 2026-11-01 | **Reliability + monitoring (migration `20261101000002_reminder_watchdog`, send-reminders v8, app):** (1) watchdog — every cron run re-sends, once, any reminder the phone has not confirmed within 2 min (same tag → no duplicate; only while the session is open and before the 8 h mark); (2) the Today screen warns when the latest reminder was not confirmed, could not be shown, was skipped (no device / registration expired), failed or was late, and while working with no registered device; (3) support query in "Checking a reminder". Limitation: no out-of-app alert channel (no e-mail sender); warnings appear the next time the app is opened. |
| 2026-11-01 | **Closed-app test passed (server evidence):** reminder-format test sent 17:55:23 Riyadh with the app closed and the phone locked → Apple 201 → device receipt `displayed_at` 17:55:26 (2.7 s), no display error. Background delivery + service-worker display path verified on the owner's iPhone. |
| 2026-11-01 | **Incident — first real reminder not seen on iPhone.** Evidence: session clock-in 09:05:44 Riyadh → reminder fire_at 16:45:44 (+7h40, correct), claimed by cron 16:46:00, Apple push service accepted it (`sent:1`, no error, subscription not removed), status `sent` at 16:46:01. The device row was re-created at 16:47:24 when the app was opened (old register = delete+insert) — same endpoint, but it erased last_success_at. The server had no way to know whether the iPhone displayed it; the morning test only proved delivery with the app open. Fix (migration `20261101000001_push_receipts`, send-reminders v7, SW): every push recorded in `push_deliveries` with the push service status and a **device receipt** sent by the service worker after `showNotification` (`displayed_at` / `display_error`); register_push_subscription now updates in place (history kept); new *Test reminder with the app closed (30 s)* in Settings + a cron-secret support path to test a user's devices. |
| 2026-11-01 | Notification test **passed**: owner received *Send test* on his iPhone (Google account). Note: test sends don't update `last_success_at`; only real reminders do. |
| 2026-11-01 | Owner tested Google sign-in on iPhone (works); Google account made primary; pre-go-live checks done (see "Accounts & go-live"); README has user instructions for sharing. |
| 2026-11-01 | Owner created the Google OAuth client and enabled the Google provider; Site URL + redirect allow-list set. Verified via a temporary read-only check (auth-admin v4–5, no secrets), then auth-admin restored to the retired stub (v6, verify_jwt on). |
| 2026-10-31 | Added public Home, Privacy Policy and Terms pages for Google's OAuth requirements; links on sign-in screens; service worker no longer answers these pages with the app shell. |


### Checking a reminder (support)

Daily overview of every reminder and whether the phone confirmed it:
```sql
select r.fire_at at time zone 'Asia/Riyadh' as fire_local, r.status, r.last_error,
       count(d.*) as attempts, max(d.push_status) as push_status, max(d.displayed_at) as confirmed_at
from public.reminders r left join public.push_deliveries d on d.session_id = r.session_id and d.kind = 'reminder'
where r.fire_at > now() - interval '7 days' group by 1,2,3 order by 1 desc;
```


```sql
select d.kind, d.sent_at, d.push_status, d.push_error, d.displayed_at, d.display_error
from public.push_deliveries d where d.user_id = '<user id>' order by d.sent_at desc limit 10;
```
`retry_of` set = the watchdog's automatic re-send of an unconfirmed reminder.
`push_status` 201 = accepted by Apple/Google; `displayed_at` set = the phone's service worker showed it. Accepted but no receipt = the device did not run/show it (app deleted from Home Screen, notifications off, or iOS did not wake the app).
Support test to a user's devices (no user action; same format as a reminder):
`select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name='attendance_project_url') || '/functions/v1/send-reminders', headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='attendance_cron_secret')), body := jsonb_build_object('type','test','userId','<user id>','delaySeconds',1));`

### Verifying auth redirect settings (tip)
pg_net follows redirects, so `/authorize`'s Location header can't be read from SQL. The state is opaque (not a JWT); read `auth.flow_state.referrer` for rows created by a test `/authorize` call instead (read-only).
