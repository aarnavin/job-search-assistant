# Muse application workflow

Muse is the primary application runner; Cloudflare stores jobs, reviewed batches, profile versions, reservations, and results. Notion is the dashboard. Existing career-board scans continue. Scheduled tasks never select applications, and the daily email digest switches off only after the pilot succeeds and the new workflow launches.

## Connect the existing Muse account

Apply migrations with `npm run db:remote` and deploy with `npm run deploy`. Then run:

```bash
node --env-file=.env --import tsx scripts/muse.ts setup
node --env-file=.env --import tsx scripts/muse.ts smoke
```

Setup generates a separate 256-bit connector credential, stores it in the Cloudflare `MUSE_TOKEN` secret, and saves the local copy to ignored `private/muse-token.txt` with owner-only permissions. It also writes ignored `private/muse-setup.md` containing a ready-to-paste Muse setup prompt. Existing credentials are reused; setup does not rotate them silently. Enter the token through Muse's secure credential flow, never in ordinary chat. A school Gmail connection inside Muse stays inside Muse.

The connector offers authenticated REST/OpenAPI at `/agent/openapi.json`, saved agent instructions at `/agent/instructions`, and a stateless MCP Streamable HTTP endpoint at `/agent/mcp`. The same Bearer credential works on these routes only. It cannot configure accounts, change application launch gates, verify profile facts, or reach existing admin routes. GET on the MCP endpoint returns 405 because server-initiated SSE is not offered. This is a fixed-token custom connector; if the client requires OAuth instead, stop and report that incompatibility rather than exposing an unauthenticated endpoint.

Meta supports custom connectors; the exact account's connection, private download, and browser upload behavior must be verified live. There is no automatic call into a Codex conversation and no dependency on paid model APIs.

## Review profile and availability

`get_profile` returns approved answers and clearly labeled pending drafts. Fact verification is an owner action, saved by an admin through the existing private profile upload. Muse cannot promote its own guesses to verified facts. Full-time availability is June 1, 2027. Spring availability has its own exact start date and 10–20 hours per week:

```json
{
  "availability": {
    "spring-flex": {
      "earliestStart": {
        "value": "OWNER_CONFIRMED_2027_DATE",
        "verified": false
      },
      "weeklyHours": { "value": "10–20", "verified": false }
    }
  }
}
```

Merge these fields into the existing private profile without replacing its other fields. Mark individual facts and the profile verified only after the owner confirms them. Use `node --env-file=.env --import tsx scripts/admin.ts profile` to upload it together with the private unchanged resume. Existing full-time profiles remain compatible; missing spring facts block spring applications. The actual resume bytes must match the approved SHA-256.

## Tools and approval

| Tool                                 | Purpose                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `connection_status` / `list_jobs`    | Check gates; list candidates and application history; optionally refresh Notion imports                                    |
| `get_profile`                        | Read verified facts and pending verification questions                                                                     |
| `add_lead`                           | Store an opened employer posting, literal evidence, observation time, and minimal email/user/search provenance             |
| `prepare_batch`                      | Freeze up to three specific jobs, the profile/resume version, written drafts, and unresolved questions                     |
| `approve_batch`                      | Record explicit owner approval of the exact review fingerprint and all writing                                             |
| `get_materials`                      | Retrieve batch answers and the authenticated private resume endpoint                                                       |
| `reserve_application`                | Reserve the job centrally before filling, in preview or submit mode                                                        |
| `authorize_submission`               | Recheck the current employer posting, user status, materials, and the completed form; authorize one immediate submit click |
| `record_result`                      | Record preview, blocked, confirmed, or uncertain results; persist before Notion updates                                    |
| `get_progress` / `retry_notion_sync` | Report outcomes and retry recording without reapplying                                                                     |
| `request_backup`                     | Explicitly request the narrow Ashby backup for a reviewed batch job                                                        |

Each tool is callable through POST `/agent/tools/TOOL_NAME` with JSON arguments, or through MCP `tools/call`. The OpenAPI and MCP schemas are generated from the same definitions and validated at runtime. `list_jobs` includes Notion-only records; research their employer URLs through `add_lead` before preparing a batch. A blank company watchlist does not become an application.

Use a stable `requestId` when retrying batch preparation. Changed contents require a new ID. Approval binds the exact posting, resume bytes, profile answers, and writing; changed materials need a new review. Approval is recorded as **Muse-relayed user approval**: the service cannot independently prove the origin of a message inside Muse. Configure Muse to ask before that tool and follow the saved instructions. Backend controls enforce its own tools, not arbitrary independent browser actions.

`add_lead` does not fetch arbitrary URLs. It records Muse's observation and checks literal evidence plus the existing matching rules. It labels the verification source truthfully. Known configured ATS boards are independently fetched again before application; custom sites require Muse to reopen and refresh the posting within 15 minutes. Start dates and missing mandatory qualifications must still be reviewed. The service does not claim a hiring guarantee.

New writing belongs in `writtenAnswers[jobId][question]` and is shown before approval. Unknown required answers belong in `unresolvedQuestions[jobId]`; any unresolved item blocks batch approval. Resume downloads require the scoped Authorization header, stay uncached, and never expose a public resume URL. Download to a private file in Muse's environment and use that file for upload.

The Muse browser must provide its actual completed form inventory immediately before submit. Include the approved resume hash as the resume field's value. All other filled values must exactly match approved facts or writing. Consent, account creation, assessments, CAPTCHAs, referrals, unsupported controls, and new questions stop the workflow. A permit allows a single immediate click and is not renewable; after 60 seconds the browser must stop and reconcile rather than click. A click with lost confirmation is uncertain. Confirmed Muse results are labeled browser observations, not independent employer API receipts.

Both runners share the unique attempts/identity ledger. A confirmed pre-submit preview or stop releases the Muse job key while retaining its audit row. Uncertain attempts never release automatically; unfinished Muse attempts older than two hours are treated as uncertain. The existing backup keeps its three-attempt, nine-browser-minute daily limit; Muse attempts do not consume Cloudflare browser minutes. The backup supports only standard Ashby forms and may hold forms Muse could complete.

## Staged launch

All configuration below uses the existing **admin** credential through `scripts/admin.ts agent-config PRIVATE_JSON_FILE`. Do not give the admin token to Muse.

1. In Muse, call `connection_status` and `list_jobs`; read a real entry. Record only actual observed evidence using `{"action":"record-test","test":"connection","evidence":"ACTUAL_RESULT"}`.
2. Verify profile facts. Prepare a selected application, show and approve it, then reserve it in **preview** mode. Download/upload the exact resume and fill without submitting. Record preview. Record the actual upload result using `{"action":"record-test","test":"upload","evidence":"ACTUAL_RESULT"}`.
3. Select an explicitly approved pilot batch/job. Use `{"action":"enable-pilot","batchId":"ID","jobId":"ID","tracks":["full-time"]}` (or spring-flex after verifying that profile). Only that job can submit. Obtain and record actual confirmation.
4. Launch with `{"action":"launch","tracks":["full-time","spring-flex"]}` after verifying both profiles. A successful confirmed Muse pilot is required. Launch disables daily emails and the old scheduled-application switch, and enables submissions only for explicitly approved batches.

If spring facts are pending, launch only full-time; spring jobs remain blocked by their profile checks. Use `{"action":"disable-submissions"}` to close the gate, or the existing global pause to stop application processing. The backend keeps confirmation recording available even after pause, so a completed application is not lost.

To release an ambiguous attempt only after the owner verifies no submission occurred, use `{"action":"reconcile-not-submitted","attemptId":"ID","evidence":"OWNER_CHECKED_EVIDENCE"}`. This preserves the audit record. For an externally confirmed uncertain application, use `{"action":"reconcile-confirmed","attemptId":"ID","text":"ACTUAL_CONFIRMATION_TEXT","url":"EMPLOYER_CONFIRMATION_URL","observedAt":"ACTUAL_APPLICATION_TIME"}`; this records owner-reported evidence and preserves the reservation. If Notion recording fails after a confirmed result, `retry_notion_sync` retries only the update and preserves later user-edited stages.

## Validation

Automated tests exercise scoped auth, MCP discovery, malformed arguments, immutable/idempotent batch reviews, separate availability, unanswered questions, runner contention, preview release, launch gates, field approval, lost confirmations, stale attempts, changed/closed postings, user edits, referral holds, and delayed Notion recording. An HTTP smoke check is not a real Muse connection/upload test; do not record those gates until the actual Muse run succeeds.
