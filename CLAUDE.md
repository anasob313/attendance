# Instructions for Claude

Read `PROJECT_STATE.md` first — it records production IDs, what is deployed, where secrets live, and the change workflow.

- Owner: non-developer, uses an iPhone only. Do the technical work yourself; involve him only for approvals or sign-ins.
- Never regenerate VAPID keys or CRON_SECRET. Never commit secrets.
- Do not delete production data without explicit approval.
- Preserve existing behaviour; run `npm test` and `npm run test:db` before pushing; push to `main` to deploy.
- Update `PROJECT_STATE.md` (status + change log) with every change.
