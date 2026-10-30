# Project State — Attendance PWA (بصمة الدوام)

Single source of truth for anyone (human or AI) continuing this project.
Update this file with every change. Last updated: **2026-10-30**.

## Production

| Item | Value |
|---|---|
| Supabase project | `attendance-pwa` · ref `jhofnqvnjbxobjisfukx` · region eu-west-1 · PostgreSQL 17 · Free plan |
| API URL | `https://jhofnqvnjbxobjisfukx.supabase.co` |
| Frontend key | publishable key `sb_publishable_…` (public; set as GitHub variable `SUPABASE_ANON_KEY`) |
| Live app URL | _not yet deployed — waiting for GitHub to be linked_ |
| Hosting | GitHub Pages, built by `.github/workflows/deploy.yml` on every push to `main` |
| Source repository | _not yet created — waiting for GitHub to be linked_ |

### Backend status (verified 2026-10-30)

| Component | Status |
|---|---|
| Schema migration `20261029000001_schema.sql` (rev 2) | ✅ applied — 7 tables with RLS, 16 public RPCs, 17 private helpers |
| Sign-up trigger `attendance_on_auth_user_created` | ✅ present; owner account exists and is confirmed |
| Edge Function `send-reminders` | ✅ v6 deployed (verify_jwt = false); secrets cleaned on read (`config.ts`) |
| Function secrets | ✅ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET — valid, key pair matches (verified by the function) |
| Vault secrets | ✅ `attendance_project_url`, `attendance_cron_secret` |
| pg_cron job `send-attendance-reminders` (every minute) | ✅ running, function returns 200 |
| Housekeeping job | ⏳ **pending owner approval** — `supabase/migrations/PENDING_20261030000002_housekeeping.sql` |
| Auth Site URL / redirect URLs | ⏳ must be set to the live URL once deployed (dashboard only) |
| Custom SMTP | ⏳ not set — only the owner can receive auth e-mails until configured |

### Secrets — where they live (never in this repository)

| Secret | Location |
|---|---|
| VAPID private key, CRON_SECRET, VAPID_SUBJECT | Supabase → Edge Functions → Secrets |
| CRON_SECRET copy, project URL | Supabase Vault |
| VAPID public key, Supabase URL, publishable key (all public) | GitHub → Settings → Secrets and variables → Actions → **Variables** |

The VAPID key pair must never be regenerated: every device would have to re-enable notifications.

## How to make a change (workflow for future sessions)

Requirements: the **Supabase** connector and a linked **GitHub** account in the session.

1. Clone the repository, read this file and `README.md`.
2. Change the code. Keep business rules in `src/lib/attendance.ts` / the SQL.
3. Test: `npm ci && npm test && npm run test:db` (+ `npm run test:e2e`, `npm run test:push` with Deno).
4. Database change → new file `supabase/migrations/<timestamp>_<name>.sql`, apply with the Supabase connector (`apply_migration`), then run the security advisor.
5. Edge Function change → deploy `index.ts`, `dispatch.ts`, `config.ts` together with `verify_jwt = false`.
6. Commit and push to `main` → GitHub Actions tests, builds and redeploys to the same URL.
7. Update this file (status + change log).

Roll back: `git revert <commit>` and push (frontend). Database changes need a new forward migration.

## Known limitations

- Free Supabase projects pause after ~7 days without activity (daily use prevents it; `keepalive.yml` pings every 2 days). No automatic backups on Free — use **Profile → Export all records**.
- GitHub disables scheduled workflows after 60 days without commits (re-enable in Actions).
- Push needs iOS 16.4+, the Home Screen app, and permission per device. Delivery is typically within ~1 minute of Clock In + 7h40.

## Change log

| Date | Change |
|---|---|
| 2026-10-29 | Initial build; migration reviewed and corrected (rev 2: explicit grants, private schema, per-user lock). |
| 2026-10-30 | Owner applied migration, deployed function, set secrets. Claude: enabled pg_cron/pg_net, stored Vault secrets, scheduled reminders; function v6 repairs pasted secrets (the stored public key had been damaged in pasting) and reports config problems instead of crashing; app made sub-path aware for GitHub Pages; deploy workflow added. |
