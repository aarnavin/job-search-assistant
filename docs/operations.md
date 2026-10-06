# Operations guide

This guide describes a new installation. The local `wrangler.jsonc`, `src/company-sources.json`, `.env`, `private/`, and `reports/` files are intentionally ignored by Git.

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and `src/company-sources.example.json` to `src/company-sources.json`.
2. Create a Cloudflare D1 database and the task and dead-letter Queues named in the config. Put the database ID into `wrangler.jsonc`.
3. Create a Notion internal integration with read, insert, and update content access, and share only the tracker with it. Fill in the Notion data source and template IDs in the local config.
4. Create a Brevo transactional-email sender and put its verified address and destination email in the local configuration.
5. Put `ADMIN_TOKEN`, `NOTION_TOKEN`, `BREVO_API_KEY`, and `BREVO_SENDER` into Worker secrets using `npx wrangler secret put NAME`. Do not place them in the config or GitHub Actions secrets unless a workflow needs them.
6. Run `npm run db:remote`, then `npm run deploy`. Create a local `.env` from `.env.example` with the Worker URL and admin token.
7. Run `node --env-file=.env --import tsx scripts/admin.ts setup`, then `resume`, then `scan`. Inspect `status`, `shortlist`, and `digest-preview` before enabling updates.
8. Run `enable sync` to add future openings to Notion. Use `sync-shortlist` only when you want to curate an initial baseline. Run `enable email` when the digest looks correct.

After changing matching rules, temporarily disable email and sync, deploy, run the reclassify admin command, and review the cleanup preview. Archive only the active pages listed there; existing application history and company-only watchlists remain in Notion. The protected cleanup command checks the current page stage, title, and posting evidence again before archiving. Recheck the cleanup and digest previews before enabling sync and email again.

The scheduled digest sends once per Pacific local day at or after 8 a.m. A timeout after the email API call is marked uncertain because delivery may have succeeded. Check Brevo before retrying. Feed errors are visible in `status`; an incomplete scan never closes jobs.

Application automation stays disabled until a profile has been fact-checked and an individual role reviewed. `fill-preview JOB_ID` fills a supported Ashby form without submitting. An uncertain submission must be reconciled manually before any retry. `pause` stops new processing; a queued application also checks pause immediately before submission.

The protected Worker routes require `Authorization: Bearer ADMIN_TOKEN`; a direct browser visit without that header returns `Unauthorized`. Admin commands are local conveniences, not a public dashboard. Notion is the daily interface.
