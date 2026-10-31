# Setup & Deployment Guide

Everything below uses free tiers. Allow about 45 minutes the first time.
You need: a computer with **Node.js 20+**, a **GitHub** account, a **Supabase** account
and a **Cloudflare** account (all free).

> Values in `<ANGLE_BRACKETS>` are yours to fill in. Keep the **service_role / secret
> key**, the **VAPID private key** and the **CRON secret** private — they never go
> into the frontend or Git.

---

## 0. Free services used (checked October 2026)

| Purpose | Service | Free tier (verify before relying on it) | Notes |
|---|---|---|---|
| Database, Auth, RLS | Supabase Free | 2 active projects, 500 MB DB, 50,000 monthly active users | **Projects pause after 7 days without activity**; no automatic backups on Free — export regularly |
| Server-side scheduling | Supabase `pg_cron` + `pg_net` | Included | Runs every minute |
| Reminder sender | Supabase Edge Function | 500,000 invocations / month | One call per minute ≈ 44,640 / month (~9 %) |
| Push delivery | Apple / Google / Mozilla Web Push services | Free, no developer account | Signed with your own VAPID keys |
| Hosting | Cloudflare Pages Free | Unlimited static bandwidth & requests, 500 builds / month | Any static host works |
| Sign-up / account recovery | Google sign-in via Supabase Auth | Free | No e-mail sender needed. Supabase's built-in mailer only reaches your Supabase team members, so e-mail sign-up is hidden (build flag `VITE_EMAIL_SIGNUP`) |

Nothing here requires a credit card. No paid service is introduced. Free tiers can
change — re-check the pricing pages before you depend on them.

---

## 1. Create the Supabase project

1. <https://supabase.com> → **New project**. Choose a strong database password and the region nearest to you.
2. When it is ready: **Project Settings → API** (or *API Keys*). Note:
   - **Project URL** → `https://<PROJECT_REF>.supabase.co`
   - **anon / publishable key** (public, goes in the frontend)
3. **SQL Editor → New query** → paste the whole file
   `supabase/migrations/20261029000001_schema.sql` → **Run**.
   You should see *Success. No rows returned.* This creates every table, the Row Level
   Security policies, the attendance functions and the reminder triggers.

### Authentication settings

**Authentication → URL Configuration**
- **Site URL**: your app URL (after step 5), e.g. `https://attendance-xyz.pages.dev`
- **Redirect URLs**: add `https://attendance-xyz.pages.dev/**` (and `http://localhost:5173/**` for local dev)

**Authentication → Sign In / Providers → Email**: enabled (default). Choose:
- *Confirm email* **on** (recommended): users click a link before first sign-in.
- *Confirm email* **off**: sign-up works instantly, useful if you have not set up SMTP yet.

### Google sign-in (how new users create accounts)

1. **Google Cloud** → <https://console.cloud.google.com/auth/overview> → create a project,
   *Branding*: app name, a support e-mail (use a Google Group address so your personal
   address is not shown), *Audience*: External → **Publish app**.
2. *Clients* → **Create client** → *Web application* → Authorized redirect URI
   `https://<PROJECT_REF>.supabase.co/auth/v1/callback`. Copy the Client ID and secret.
3. **Supabase → Authentication → Sign In / Providers → Google** → enable, paste both → Save.

E-mail + password sign-in keeps working for existing accounts. E-mail sign-up is hidden
unless the site is built with `VITE_EMAIL_SIGNUP=true`; only enable that after setting up
custom SMTP with your own domain (e.g. Resend's free tier), because without it confirmation
and reset e-mails reach **only** members of your Supabase organization.

---

## 2. Create the push (VAPID) keys

```bash
npm install
npm run vapid
```

Output:
```
VAPID_PUBLIC_KEY=BK...   ← frontend + Edge Function
VAPID_PRIVATE_KEY=...    ← Edge Function ONLY
```

Also create a random secret for the cron call:
```bash
openssl rand -hex 32        # or: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

---

## 3. Deploy the reminder Edge Function

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>

npx supabase secrets set \
  VAPID_PUBLIC_KEY=<public key> \
  VAPID_PRIVATE_KEY=<private key> \
  VAPID_SUBJECT=mailto:<your email> \
  CRON_SECRET=<random secret>

npx supabase functions deploy send-reminders --no-verify-jwt
```

`--no-verify-jwt` is intentional: the scheduler authenticates with `x-cron-secret`,
and the "Send test" button authenticates by verifying the user's own token inside the
function. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
If your project's function environment does not provide `SUPABASE_SERVICE_ROLE_KEY`,
add it yourself: `npx supabase secrets set SERVICE_ROLE_KEY=<service_role / secret key>`.

---

## 4. Turn on the every-minute scheduler

Open `supabase/setup/cron.sql`, replace `<PROJECT_REF>` and `<CRON_SECRET>`
(same value as step 3), paste it into **SQL Editor** and **Run**.

Check it after a couple of minutes:
```sql
select * from cron.job_run_details order by start_time desc limit 5;   -- status = succeeded
select status_code, content from net._http_response order by created desc limit 5; -- 200 {"claimed":0,…}
```

---

## 5. Host the app on Cloudflare Pages

1. Push this folder to a **GitHub repository** (private is fine).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings:
   - Framework preset: **Vite** (or *None*)
   - Build command: `npm run build`
   - Output directory: `dist`
4. **Environment variables** (Production *and* Preview):
   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<PROJECT_REF>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | anon / publishable key |
   | `VITE_VAPID_PUBLIC_KEY` | VAPID **public** key |
   | `NODE_VERSION` | `22` |
5. **Save and Deploy**. You get `https://<name>.pages.dev` (HTTPS is required for PWA and push).
6. Go back to Supabase → Authentication → URL Configuration and set **Site URL / Redirect URLs** to this address.

`public/_redirects` (SPA routing) and `public/_headers` (no-cache for the service worker)
are already included. Any other static host (Netlify, Vercel Hobby for personal use,
GitHub Pages with a 404 fallback) also works.

Alternative without Git: `npm run build && npx wrangler pages deploy dist`.

---

## 6. Install on iPhone (each user)

Requires **iOS / iPadOS 16.4 or later**.

1. Open the app URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open the app **from the new icon** and sign up / sign in there (the Home Screen app
   keeps its own sign-in, separate from Safari).
4. **Settings → Notifications → Enable notifications on this device** → **Allow**.
5. Tap **Send test** — a notification should appear within seconds. Lock the phone and
   send another test from a second device to confirm locked-screen delivery.

Each device (iPhone, iPad, laptop) registers separately and each receives the reminder.

---

## 7. Optional: keep the free project awake

Daily use counts as activity. For long holidays, the included GitHub Action
`.github/workflows/keepalive.yml` calls a harmless `ping()` function every two days.
Add repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`. (GitHub disables
scheduled workflows in repositories with no commits for 60 days — re-enable from the
Actions tab if that happens.)

If the project does pause, open the Supabase dashboard and click **Restore**; no data is lost.

---

## 8. Local development

```bash
cp .env.example .env.local      # fill in the three VITE_ values
npm install
npm run dev                      # http://localhost:5173
```

The service worker (offline + push) is active in `npm run build && npm run preview`, not in `dev`.

## 9. Updating

- Frontend: push to GitHub — Cloudflare rebuilds automatically; installed apps update on next launch.
- Database: add a new file under `supabase/migrations/` and run it in the SQL Editor.
- Edge Function: `npx supabase functions deploy send-reminders --no-verify-jwt`.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| "Setup required" screen | The three `VITE_` variables were not set at build time — set them and redeploy |
| "Email address not authorized" on sign-up | Custom SMTP is not configured — new users should use **Continue with Google** |
| Notification button missing on iPhone | App not opened from the Home Screen icon, or iOS < 16.4 |
| "Notifications are blocked" | iPhone Settings → Notifications → Attendance → Allow |
| Test works, 7h40 reminder doesn't | `cron.job_run_details` and `net._http_response` (step 4); `select * from reminders order by updated_at desc` |
| Reminder status `skipped` | Its time had already passed when the session was created/edited/synced (by design: no late reminders) |
| Project unreachable after a break | Free project paused → Restore in the Supabase dashboard |
