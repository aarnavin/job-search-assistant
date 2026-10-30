import { Notion, fromPage } from "./notion";
import {
  companyKey,
  identities,
  jobIdentity,
  normalizeUrl,
  plainTitle,
} from "./identity";
import { rank, rankFlexible } from "./matching";
import {
  duplicate,
  importPages,
  jobRow,
  referralHold,
  setting,
  setSetting,
} from "./store";
import { syncJob } from "./pipeline";
import { fetchJobs, stripHtml } from "./sources";
import {
  claimApplication,
  expireMuseAttempts,
  fingerprint,
  jobFingerprint,
  privateMaterials,
  trackProfileProblems,
  type ApplicationAttempt,
} from "./application-state";
import type { Env, Job, SearchTrack, Source } from "./types";

export class AgentError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export type PostingReview = {
  track: SearchTrack;
  provenance: {
    kind: "email" | "user" | "search";
    emailId?: string;
    mailbox?: string;
    excerpt?: string;
  };
  evidence: string[];
  reviewed_at: string;
};
export type BatchItem = {
  jobId: string;
  company: string;
  title: string;
  url: string;
  applyUrl: string;
  location: string;
  track: SearchTrack;
  notionId: string | null;
  jobHash: string;
  reasons: string[];
  answers: Record<string, string>;
  unresolved: string[];
  writtenAnswers: Record<string, string>;
};
type BatchSnapshot = {
  profileVersion: string;
  resumeHash: string;
  items: BatchItem[];
  requestHash?: string;
};
type Batch = {
  id: string;
  snapshot: string;
  fingerprint: string;
  state: string;
  approval: string | null;
};
const now = () => new Date().toISOString();
const notionLink = (id: string | null) =>
  id ? `https://www.notion.so/${id.replaceAll("-", "")}` : null;
export function postingUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentError("Invalid posting URL", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /(^localhost$|\.local$|\.internal$|^[\d.]+$|:)/i.test(url.hostname) ||
    url.pathname.split("/").filter(Boolean).length < 2 ||
    !normalizeUrl(raw)
  )
    throw new AgentError(
      "Use a specific public HTTPS employer posting, not a shared portal or login URL",
      400,
    );
  return url;
}
async function review(env: Env, job: Job): Promise<PostingReview> {
  const row = await env.DB.prepare(
    "SELECT * FROM agent_postings WHERE job_id=?",
  )
    .bind(job.id)
    .first<{
      track: SearchTrack;
      provenance: string;
      evidence: string;
      reviewed_at: string;
    }>();
  if (row)
    return {
      ...row,
      provenance: JSON.parse(row.provenance),
      evidence: JSON.parse(row.evidence),
    };
  const source = await env.DB.prepare("SELECT data FROM sources WHERE id=?")
    .bind(job.sourceId)
    .first<{ data: string }>();
  return {
    track:
      source && JSON.parse(source.data).track === "spring-flex"
        ? "spring-flex"
        : "full-time",
    provenance: { kind: "search" },
    evidence: [],
    reviewed_at: "",
  };
}
async function batch(
  env: Env,
  id: string,
): Promise<{ row: Batch; data: BatchSnapshot }> {
  const row = await env.DB.prepare(
    "SELECT * FROM application_batches WHERE id=?",
  )
    .bind(id)
    .first<Batch>();
  if (!row) throw new AgentError("Unknown batch", 404);
  return { row, data: JSON.parse(row.snapshot) };
}
async function activeNotion(env: Env, job: Job, pageId: string | null) {
  if (!pageId)
    throw new AgentError("Sync this opening to Notion before applying");
  const notion = new Notion(env);
  const raw = await notion.page(pageId);
  const page = fromPage(raw);
  if (raw.parent?.data_source_id !== env.NOTION_DATA_SOURCE_ID)
    throw new AgentError("Application page belongs to another tracker");
  if (page.archived || page.stage !== "To apply")
    throw new AgentError("Notion status changed; preserve application history");
  if (
    companyKey(page.company) !== companyKey(job.company) ||
    plainTitle(page.title) !== plainTitle(job.title) ||
    !identities(page.links).some((id) =>
      identities([job.url, job.applyUrl]).includes(id),
    )
  )
    throw new AgentError(
      "Notion employer, position, or posting link changed; review this record again",
    );
  if (
    ["Paused", "Closed", "Submitted", "Uncertain"].includes(
      raw.properties["Automation Status"]?.select?.name,
    )
  )
    throw new AgentError(
      "Application is paused, closed, submitted, or uncertain",
    );
  if (
    page.referral ||
    (await referralHold(env, job.company)) ||
    /referral|refer me|referred by|introduction/i.test(
      await notion.content(pageId),
    )
  )
    throw new AgentError("Referral opportunity requires manual review");
}
export async function checkedBatchItem(
  env: Env,
  batchId: string,
  jobId: string,
) {
  if ((await setting(env, "paused")) === "true")
    throw new AgentError("Tracker paused");
  const { row: b, data } = await batch(env, batchId);
  if (b.state !== "approved")
    throw new AgentError("This batch needs explicit user approval");
  const item = data.items.find((j) => j.jobId === jobId);
  if (!item || item.unresolved.length)
    throw new AgentError("Job is not approved or has unanswered requirements");
  const row = await jobRow(env, jobId);
  if (!row?.open) throw new AgentError("Posting is closed or missing");
  const job: Job = JSON.parse(row.data);
  if ((await review(env, job)).track !== item.track)
    throw new AgentError(
      "Search track changed; prepare and approve a new batch",
    );
  const materials = await privateMaterials(env);
  if (
    data.profileVersion !== materials.version ||
    data.resumeHash !== materials.resumeHash ||
    item.jobHash !== (await jobFingerprint(job))
  )
    throw new AgentError(
      "Posting, profile, or resume changed; prepare and approve a new batch",
    );
  const { profile, problems } = trackProfileProblems(
    materials.profile,
    item.track,
  );
  if (problems.length) throw new AgentError(problems.join("; "));
  await activeNotion(env, job, row.notion_id);
  const source = await env.DB.prepare("SELECT data FROM sources WHERE id=?")
    .bind(job.sourceId)
    .first<{ data: string }>();
  const s: Source | undefined = source ? JSON.parse(source.data) : undefined;
  if (s && s.ats !== "manual") {
    const fresh = (await fetchJobs(s)).find((j) => j.id === jobId && j.listed);
    if (!fresh || (await jobFingerprint(fresh)) !== item.jobHash)
      throw new AgentError("Employer posting closed or changed; review again");
  } else {
    const r = await review(env, job);
    if (!r.reviewed_at || Date.now() - Date.parse(r.reviewed_at) > 15 * 60000)
      throw new AgentError(
        "Reopen the employer posting and call add_lead with its current text before applying",
      );
  }
  return { item, job, row, profile, materials };
}
async function profileStatus(env: Env) {
  const m = await privateMaterials(env);
  return {
    verified: m.profile.verified,
    resumeVersion: m.resumeHash,
    approvedAnswers: Object.fromEntries(
      Object.entries(m.profile.answers).filter(([, a]) => a.verified),
    ),
    needsVerification: Object.entries(m.profile.answers)
      .filter(([, a]) => !a.verified)
      .map(([key, a]) => ({ key, value: a.value, verified: false })),
    tracks: Object.fromEntries(
      (["full-time", "spring-flex"] as SearchTrack[]).map((track) => [
        track,
        { ...trackProfileProblems(m.profile, track), profile: undefined },
      ]),
    ),
    instructions:
      "Unverified values are review drafts, not application answers. Ask the user to verify facts; a tracker admin must save the approved profile.",
  };
}
async function addLead(env: Env, args: any) {
  const input = args.job;
  postingUrl(input.url);
  postingUrl(input.applyUrl);
  const id = jobIdentity(input.url)!;
  const ats = id.startsWith("ashby:")
    ? "ashby"
    : id.startsWith("greenhouse:")
      ? "greenhouse"
      : id.startsWith("lever:")
        ? "lever"
        : "manual";
  const previous = await jobRow(env, id);
  const sourceId =
    previous?.source_id ??
    (ats === "manual"
      ? `agent-${args.track}`
      : `agent-${ats}-${id.split(":")[1]}-${args.track}`);
  const source: Source = {
    id: sourceId,
    company: input.company,
    ats,
    track: args.track,
    ...(ats !== "manual" ? { board: id.split(":")[1] } : {}),
  };
  let job: Job = {
    ...input,
    id,
    sourceId,
    ats,
    postedAt: input.postedAt ?? null,
  };
  if (ats !== "manual") {
    const fresh = (await fetchJobs(source)).find(
      (j) => j.id === id && j.listed,
    );
    if (!fresh)
      throw new AgentError("Employer board does not list this opening");
    job = fresh;
  }
  if (
    !args.evidence.every((quote: string) =>
      stripHtml(job.description).includes(stripHtml(quote)),
    )
  )
    throw new AgentError(
      "Evidence must be literal excerpts from the employer description",
      400,
    );
  if (
    Math.abs(Date.now() - Date.parse(args.observedAt)) > 3600000 ||
    !Number.isFinite(Date.parse(args.observedAt))
  )
    throw new AgentError(
      "Provide the time you actually read the employer posting (within the last hour)",
      400,
    );
  const notion = new Notion(env);
  await importPages(env, await notion.pages());
  const existing = await duplicate(
    env,
    [job.url, job.applyUrl],
    job.company,
    job.title,
  );
  if (existing?.ambiguous && previous?.notion_id !== existing.id)
    throw new AgentError(
      "Possible duplicate has the same company/title but different links; reconcile it first",
    );
  const fit = args.track === "spring-flex" ? rankFlexible(job) : rank(job);
  await env.DB.prepare("INSERT OR IGNORE INTO sources(id,data) VALUES(?,?)")
    .bind(sourceId, JSON.stringify(source))
    .run();
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs(id,source_id,data,fit,reasons,first_seen,last_seen,baseline,open,notion_id) VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,fit=excluded.fit,reasons=excluded.reasons,last_seen=excluded.last_seen,open=excluded.open",
    ).bind(
      id,
      job.sourceId,
      JSON.stringify(job),
      fit.label,
      JSON.stringify(fit.reasons),
      timestamp,
      timestamp,
      +job.listed,
      existing?.id ?? null,
    ),
    env.DB.prepare(
      "INSERT INTO agent_postings(job_id,track,provenance,evidence,reviewed_at) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET track=excluded.track,provenance=excluded.provenance,evidence=excluded.evidence,reviewed_at=excluded.reviewed_at",
    ).bind(
      id,
      args.track,
      JSON.stringify(args.provenance),
      JSON.stringify(args.evidence),
      args.observedAt,
    ),
  ]);
  if (previous && existing && !previous.notion_id)
    await env.DB.prepare("UPDATE jobs SET notion_id=? WHERE id=?")
      .bind(existing.id, id)
      .run();
  let syncError: string | undefined;
  if (!existing && fit.label !== "Skip") {
    try {
      await syncJob(env, id);
    } catch {
      syncError =
        "Notion update pending; check status before retrying creation";
    }
  }
  const row = await jobRow(env, id);
  return {
    jobId: id,
    fit,
    stage: existing ? "Existing Notion record preserved" : "Lead recorded",
    notionUrl: notionLink(row?.notion_id ?? null),
    syncError,
    verificationSource:
      ats === "manual"
        ? "Muse-observed employer posting; not independently fetched by this endpoint"
        : "Employer ATS API independently fetched",
  };
}
async function prepareBatch(env: Env, args: any) {
  const previous = await env.DB.prepare(
    "SELECT * FROM application_batches WHERE request_key=?",
  )
    .bind(args.requestId)
    .first<Batch>();
  if (previous) {
    if (JSON.parse(previous.snapshot).requestHash !== (await fingerprint(args)))
      throw new AgentError(
        "Request ID already used for different batch contents",
      );
    return {
      batchId: previous.id,
      fingerprint: previous.fingerprint,
      state: previous.state,
      ...JSON.parse(previous.snapshot),
    };
  }
  const m = await privateMaterials(env);
  const items: BatchItem[] = [];
  for (const id of args.jobIds as string[]) {
    const row = await jobRow(env, id);
    if (!row)
      throw new AgentError(
        `Unknown job ${id}; use add_lead with the employer posting first`,
        404,
      );
    const job: Job = JSON.parse(row.data);
    const r = await review(env, job);
    const fit = r.track === "spring-flex" ? rankFlexible(job) : rank(job);
    const { profile, problems } = trackProfileProblems(m.profile, r.track);
    const unresolved = [...problems];
    const experience = [
      ...job.description.matchAll(
        /\b([012])(?:\s*[-–]\s*[012])?\s*\+?\s*years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|hands-on\s+|work\s+)?experience\b/gi,
      ),
    ].filter(
      (match) =>
        !/(?:preferred|nice to have|bonus|desirable)[^.!?]{0,100}$/i.test(
          job.description.slice(
            Math.max(0, (match.index ?? 0) - 100),
            match.index,
          ),
        ),
    );
    if (experience.length) {
      const required = Math.max(...experience.map((match) => Number(match[1])));
      const answer = profile.answers.professionalYears;
      if (
        !answer?.verified ||
        !Number.isFinite(Number(answer.value)) ||
        Number(answer.value) < required
      )
        unresolved.push(
          `Verify professional experience against the employer's ${required}-year minimum`,
        );
    }
    if (fit.label === "Skip") unresolved.push(...fit.reasons);
    if (!row.open) unresolved.push("Posting is closed");
    if (m.profile.resumeSha256 !== m.resumeHash)
      unresolved.push("Resume version has not been verified");
    try {
      await activeNotion(env, job, row.notion_id);
    } catch (e) {
      unresolved.push((e as Error).message);
    }
    const writtenAnswers = args.writtenAnswers?.[id] ?? {};
    for (const [question, value] of Object.entries(writtenAnswers)) {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 6000 ||
        question.length > 500
      )
        throw new AgentError("Invalid written answer", 400);
    }
    for (const question of args.unresolvedQuestions?.[id] ?? [])
      unresolved.push(`Needs your answer: ${question}`);
    items.push({
      jobId: id,
      company: job.company,
      title: job.title,
      url: job.url,
      applyUrl: job.applyUrl,
      location: job.location,
      track: r.track,
      notionId: row.notion_id,
      jobHash: await jobFingerprint(job),
      reasons: fit.reasons,
      answers: Object.fromEntries(
        Object.entries(profile.answers)
          .filter(([, a]) => a.verified)
          .map(([key, a]) => [key, a.value]),
      ),
      unresolved: [...new Set(unresolved)],
      writtenAnswers,
    });
  }
  const snapshot: BatchSnapshot = {
    profileVersion: m.version,
    resumeHash: m.resumeHash,
    items,
    requestHash: await fingerprint(args),
  };
  const hash = await fingerprint(snapshot),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO application_batches(id,request_key,snapshot,fingerprint,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(id, args.requestId, JSON.stringify(snapshot), hash, now())
    .run();
  return {
    batchId: id,
    fingerprint: hash,
    state: "draft",
    ...snapshot,
    instructions:
      "Show this exact batch, resume version, answers, and any drafted writing to the user. Submit only after explicit approval. Prepare a new smaller batch if any selected item has blockers.",
  };
}
async function approveBatch(env: Env, args: any) {
  const { row, data } = await batch(env, args.batchId);
  if (row.fingerprint !== args.fingerprint)
    throw new AgentError("Review fingerprint changed");
  if (data.items.some((j) => j.unresolved.length))
    throw new AgentError("Resolve questions before approving this batch");
  if (data.profileVersion !== (await privateMaterials(env)).version)
    throw new AgentError("Profile changed; prepare a new batch");
  for (const item of data.items) {
    const current = await jobRow(env, item.jobId);
    if (
      !current?.open ||
      (await jobFingerprint(JSON.parse(current.data))) !== item.jobHash
    )
      throw new AgentError("Posting changed; prepare a new batch");
    await activeNotion(env, JSON.parse(current.data), current.notion_id);
  }
  await env.DB.prepare(
    "UPDATE application_batches SET state='approved',approved_at=?,approval=? WHERE id=? AND state='draft'",
  )
    .bind(
      now(),
      JSON.stringify({
        source: "Muse-relayed user approval",
        text: args.userApproval,
      }),
      args.batchId,
    )
    .run();
  return {
    batchId: row.id,
    state: "approved",
    approvalSource: "Muse-relayed user approval",
    submissionEnabled:
      (await setting(env, "agent_submissions_enabled")) === "true",
  };
}
async function reserveApplication(env: Env, args: any) {
  const checked = await checkedBatchItem(env, args.batchId, args.jobId);
  if (
    args.mode === "submit" &&
    (await setting(env, "agent_submissions_enabled")) !== "true"
  )
    throw new AgentError(
      "Submission gate is closed; complete connector/upload testing and an admin launch first",
    );
  const pilot = await setting(env, "agent_pilot_job", "");
  if (args.mode === "submit" && pilot && args.jobId !== pilot)
    throw new AgentError("Pilot mode only permits the selected pilot job");
  const attemptId = await claimApplication(
    env,
    checked.job,
    "muse",
    args.batchId,
  );
  if (!attemptId)
    throw new AgentError(
      "This application is already reserved, attempted, or submitted; check progress",
    );
  await env.DB.prepare("UPDATE attempts SET evidence=? WHERE id=?")
    .bind(JSON.stringify({ mode: args.mode }), attemptId)
    .run();
  return {
    attemptId,
    mode: args.mode,
    jobId: args.jobId,
    batchId: args.batchId,
    instructions:
      args.mode === "preview"
        ? "Fill without submitting; record preview or blocked afterwards"
        : "Fill approved answers. Call authorize_submission immediately before clicking submit.",
  };
}
async function attempt(env: Env, id: string) {
  const a = await env.DB.prepare(
    "SELECT * FROM attempts WHERE id=? AND runner='muse'",
  )
    .bind(id)
    .first<ApplicationAttempt>();
  if (!a?.batch_id)
    throw new AgentError("Unknown Muse application attempt", 404);
  return a;
}
async function authorizeSubmission(env: Env, args: any) {
  const a = await attempt(env, args.attemptId);
  const evidence = JSON.parse(a.evidence ?? "{}");
  if (evidence.mode !== "submit" || a.state !== "preparing")
    throw new AgentError("Attempt cannot be submitted");
  if ((await setting(env, "agent_submissions_enabled")) !== "true")
    throw new AgentError("Submissions disabled");
  const { item } = await checkedBatchItem(env, a.batch_id!, a.job_id);
  if (
    (await setting(env, "agent_pilot_job", "")) &&
    (await setting(env, "agent_pilot_job", "")) !== a.job_id
  )
    throw new AgentError("Pilot mode only permits the selected pilot job");
  // Require the browser's actual field inventory, not an assertion that a form is simple.
  const resumeHash = (await privateMaterials(env)).resumeHash;
  const unknown = args.fields.filter((field: any) => {
    if (field.kind === "resume") return field.value !== resumeHash;
    const approved =
      field.kind === "written"
        ? item.writtenAnswers[field.key]
        : item.answers[field.key];
    return approved === undefined || approved !== field.value;
  });
  if (unknown.length)
    throw new AgentError(
      "New or changed form answers require a fresh reviewed batch",
    );
  if (!args.fields.some((f: any) => f.kind === "resume"))
    throw new AgentError("Verify the approved resume upload first");
  const granted = now();
  const result = await env.DB.prepare(
    "UPDATE attempts SET state='submitting',evidence=? WHERE id=? AND state='preparing'",
  )
    .bind(
      JSON.stringify({
        ...evidence,
        authorizedAt: granted,
        fields: args.fields,
      }),
      a.id,
    )
    .run();
  if (!result.meta.changes)
    throw new AgentError(
      "Submission was already authorized; reconcile instead of clicking again",
    );
  return {
    attemptId: a.id,
    submitAllowed: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    instructions:
      "Click submit once now. If delayed more than 60 seconds, stop and record uncertain; do not request another permit or retry.",
  };
}
async function recordResult(env: Env, args: any) {
  const a = await attempt(env, args.attemptId);
  const old = JSON.parse(a.evidence ?? "{}");
  if (["confirmed", "blocked", "preview", "uncertain"].includes(a.state)) {
    if (a.state !== args.outcome)
      throw new AgentError(
        "Attempt is terminal; reconcile rather than overwrite its outcome",
      );
    return syncResult(env, a);
  }
  if (args.outcome === "confirmed") {
    if (a.state !== "submitting" || old.mode !== "submit")
      throw new AgentError("No authorized submission was recorded");
    if (
      !args.confirmation ||
      !/application.{0,60}(submitted|received)|thank you for applying/i.test(
        args.confirmation.text,
      )
    )
      throw new AgentError(
        "Provide observed application confirmation text",
        400,
      );
    postingUrl(args.confirmation.url);
    const { data } = await batch(env, a.batch_id!);
    const item = data.items.find((j) => j.jobId === a.job_id)!;
    const allowedHosts = [
      new URL(item.url).hostname,
      new URL(item.applyUrl).hostname,
    ];
    if (!allowedHosts.includes(new URL(args.confirmation.url).hostname))
      throw new AgentError(
        "Confirmation must be on the approved employer/application host",
        400,
      );
  }
  if (
    args.outcome === "preview" &&
    (old.mode !== "preview" || a.state !== "preparing")
  )
    throw new AgentError("Attempt is not a fill-only preview");
  if (args.outcome === "blocked" && a.state === "submitting")
    throw new AgentError("A submit was authorized; record uncertain instead");
  const evidence = {
    ...old,
    source: "Muse browser observation",
    confirmation: args.confirmation,
    detail: args.detail,
  };
  await env.DB.prepare(
    "UPDATE attempts SET state=?,finished_at=?,evidence=?,error=? WHERE id=? AND state=?",
  )
    .bind(
      args.outcome,
      now(),
      JSON.stringify(evidence),
      args.outcome === "blocked" || args.outcome === "uncertain"
        ? args.detail
        : null,
      a.id,
      a.state,
    )
    .run();
  const updated = await attempt(env, a.id);
  const result = await syncResult(env, updated);
  // A confirmed pre-submit stop can release its canonical key. Preserve its full audit row.
  if (["blocked", "preview"].includes(updated.state))
    await env.DB.prepare(
      "UPDATE attempts SET job_id=job_id || ':history:' || id,identity=NULL WHERE id=? AND identity IS NOT NULL",
    )
      .bind(a.id)
      .run();
  return result;
}
async function syncResult(env: Env, a: ApplicationAttempt) {
  const { data } = await batch(env, a.batch_id!);
  const item = data.items.find(
    (j) => a.job_id === j.jobId || a.job_id.startsWith(j.jobId + ":history:"),
  );
  if (!item) throw new AgentError("Batch record missing its job");
  let syncPending = false;
  const status =
    a.state === "confirmed"
      ? "Submitted"
      : a.state === "uncertain"
        ? "Uncertain"
        : "Review";
  await env.DB.prepare("UPDATE jobs SET automation=?,needs_input=? WHERE id=?")
    .bind(status, +(a.state !== "confirmed"), item.jobId)
    .run();
  if (item.notionId) {
    try {
      const notion = new Notion(env);
      if (a.state === "confirmed")
        await notion.submitted(item.notionId, a.finished_at!);
      else if (a.state !== "preview")
        await notion.setAutomation(item.notionId, status, true);
    } catch {
      syncPending = true;
    }
  }
  return {
    attemptId: a.id,
    state: a.state,
    notionUrl: notionLink(item.notionId),
    notionSyncPending: syncPending,
  };
}
async function progress(env: Env, args: any) {
  await expireMuseAttempts(env);
  const batches = args.batchId
    ? [(await batch(env, args.batchId)).row]
    : (
        await env.DB.prepare(
          "SELECT * FROM application_batches ORDER BY created_at DESC LIMIT 10",
        ).all<Batch>()
      ).results;
  const result = [];
  for (const b of batches) {
    const data: BatchSnapshot = JSON.parse(b.snapshot);
    const attempts = await env.DB.prepare(
      "SELECT * FROM attempts WHERE batch_id=? ORDER BY started_at",
    )
      .bind(b.id)
      .all<ApplicationAttempt>();
    result.push({
      batchId: b.id,
      state: b.state,
      items: data.items.map((j) => {
        const a = [...attempts.results]
          .reverse()
          .find(
            (a) =>
              a.job_id === j.jobId ||
              a.job_id.startsWith(j.jobId + ":history:"),
          );
        return {
          jobId: j.jobId,
          company: j.company,
          title: j.title,
          notionUrl: notionLink(j.notionId),
          category:
            a?.state === "confirmed"
              ? "Submitted"
              : j.unresolved.length ||
                  a?.state === "blocked" ||
                  a?.state === "uncertain"
                ? "Needs your answer"
                : "Couldn’t complete",
          state:
            a?.state ?? (j.unresolved.length ? "needs_input" : "not_started"),
          unresolved: j.unresolved,
          attemptId: a?.id,
          error: a?.error,
          evidence: a?.evidence ? JSON.parse(a.evidence) : undefined,
        };
      }),
    });
  }
  return { batches: result };
}
export async function runAgentTool(
  env: Env,
  name: string,
  args: any,
  baseUrl: string,
): Promise<any> {
  switch (name) {
    case "connection_status":
      return {
        service: "Job Search Assistant",
        submissionEnabled:
          (await setting(env, "agent_submissions_enabled")) === "true",
        connectionTested:
          (await setting(env, "muse_connection_tested")) === "true",
        uploadTested: (await setting(env, "muse_upload_tested")) === "true",
        profileConfigured: !!(await env.DB.prepare(
          "SELECT key FROM private_data WHERE key='profile'",
        ).first()),
        instructionsUrl: `${baseUrl}/agent/instructions`,
        apiUrl: `${baseUrl}/agent/openapi.json`,
      };
    case "list_jobs": {
      if (args.refresh) await importPages(env, await new Notion(env).pages());
      const rows = await env.DB.prepare(
        "SELECT jobs.*,COALESCE(agent_postings.track,json_extract(sources.data,'$.track'),'full-time') AS search_track,existing_pages.stage AS notion_stage,existing_pages.archived AS notion_archived FROM jobs LEFT JOIN agent_postings ON agent_postings.job_id=jobs.id LEFT JOIN sources ON sources.id=jobs.source_id LEFT JOIN existing_pages ON existing_pages.id=jobs.notion_id ORDER BY first_seen DESC LIMIT 500",
      ).all<any>();
      const jobs = [];
      for (const row of rows.results) {
        const j: Job = JSON.parse(row.data);
        if (args.track && args.track !== row.search_track) continue;
        if (
          args.query &&
          !(j.title + " " + j.company)
            .toLowerCase()
            .includes(args.query.toLowerCase())
        )
          continue;
        if (
          !args.includeHistory &&
          (!row.open ||
            row.fit === "Skip" ||
            row.automation === "Submitted" ||
            row.notion_archived ||
            (row.notion_stage && row.notion_stage !== "To apply"))
        )
          continue;
        jobs.push({
          jobId: j.id,
          company: j.company,
          title: j.title,
          url: j.url,
          location: j.location,
          track: row.search_track,
          fit: row.fit,
          stage: row.notion_stage ?? "To apply",
          notionUrl: notionLink(row.notion_id),
        });
      }
      const history = (
        await env.DB.prepare(
          "SELECT id,company,title,stage,links FROM existing_pages WHERE archived=0 AND title<>'' ORDER BY company",
        ).all<any>()
      ).results;
      return {
        jobs: jobs.slice(0, args.limit ?? 30),
        existingNotionRecords: history
          .filter(
            (p) =>
              (!args.query ||
                (p.company + " " + p.title)
                  .toLowerCase()
                  .includes(args.query.toLowerCase())) &&
              (args.includeHistory || p.stage === "To apply"),
          )
          .slice(0, args.limit ?? 30)
          .map((p) => ({
            ...p,
            links: JSON.parse(p.links),
            notionUrl: notionLink(p.id),
          })),
        instructions:
          "Use add_lead to research/import an existing Notion-only opening before preparing its application.",
      };
    }
    case "get_profile":
      return profileStatus(env);
    case "add_lead":
      return addLead(env, args);
    case "prepare_batch":
      return prepareBatch(env, args);
    case "approve_batch":
      return approveBatch(env, args);
    case "get_materials": {
      const { row, data } = await batch(env, args.batchId);
      const m = await privateMaterials(env);
      if (data.profileVersion !== m.version)
        throw new AgentError("Materials changed; prepare a new batch");
      if (m.profile.resumeSha256 !== m.resumeHash)
        throw new AgentError("The current resume file has not been approved");
      return {
        batchId: row.id,
        resumeVersion: m.resumeHash,
        resumeUrl: `${baseUrl}/agent/resume?batchId=${encodeURIComponent(row.id)}`,
        authentication:
          "Use the connector Bearer token in the Authorization header to download; save the response privately as resume.pdf. No public download URL is provided.",
        items: data.items.map((j) => ({
          jobId: j.jobId,
          answers: j.answers,
          writtenAnswers: j.writtenAnswers,
          unresolved: j.unresolved,
        })),
      };
    }
    case "reserve_application":
      return reserveApplication(env, args);
    case "authorize_submission":
      return authorizeSubmission(env, args);
    case "record_result":
      return recordResult(env, args);
    case "get_progress":
      return progress(env, args);
    case "retry_notion_sync":
      return syncResult(env, await attempt(env, args.attemptId));
    case "request_backup": {
      const { job } = await checkedBatchItem(env, args.batchId, args.jobId);
      if (job.ats !== "ashby")
        throw new AgentError("Backup supports standard Ashby forms only");
      if (
        await env.DB.prepare(
          "SELECT id FROM attempts WHERE job_id=? OR identity=?",
        )
          .bind(job.id, jobIdentity(job.url))
          .first()
      )
        throw new AgentError(
          "Another runner already attempted/reserved this application",
        );
      if (
        args.mode === "submit" &&
        (await setting(env, "agent_submissions_enabled")) !== "true"
      )
        throw new AgentError("Submissions disabled");
      const pilot = await setting(env, "agent_pilot_job", "");
      if (args.mode === "submit" && pilot && job.id !== pilot)
        throw new AgentError("Pilot job only");
      await env.TASKS.send({
        type: "apply",
        jobId: job.id,
        batchId: args.batchId,
        dryRun: args.mode !== "submit",
      });
      return { queued: true, runner: "backup", mode: args.mode };
    }
    default:
      throw new AgentError("Unknown connector tool", 404);
  }
}
export async function resumeResponse(env: Env, batchId: string) {
  const { data } = await batch(env, batchId),
    m = await privateMaterials(env);
  if (data.profileVersion !== m.version || data.resumeHash !== m.resumeHash)
    throw new AgentError("Resume changed; prepare a new batch");
  if (m.profile.resumeSha256 !== m.resumeHash)
    throw new AgentError("The current resume file has not been approved");
  return new Response(m.bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=resume.pdf",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function configureAgent(env: Env, body: any) {
  if (body.action === "record-test") {
    if (
      !["connection", "upload"].includes(body.test) ||
      typeof body.evidence !== "string" ||
      !body.evidence.trim()
    )
      throw new AgentError("Record observed Muse test evidence", 400);
    await setSetting(
      env,
      body.test === "connection"
        ? "muse_connection_tested"
        : "muse_upload_tested",
      "true",
    );
    await env.DB.prepare(
      "INSERT INTO private_data(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    )
      .bind(
        `muse-test-${body.test}`,
        JSON.stringify({ at: now(), evidence: body.evidence.slice(0, 2000) }),
      )
      .run();
    return { recorded: body.test };
  }
  if (body.action === "launch" || body.action === "enable-pilot") {
    if (
      (await setting(env, "muse_connection_tested")) !== "true" ||
      (await setting(env, "muse_upload_tested")) !== "true"
    )
      throw new AgentError(
        "Complete real Muse connection and fill-only upload tests first",
      );
    const m = await privateMaterials(env);
    const tracks = body.tracks as SearchTrack[];
    if (
      !Array.isArray(tracks) ||
      !tracks.length ||
      tracks.some((t) => !["full-time", "spring-flex"].includes(t))
    )
      throw new AgentError("Select verified tracks", 400);
    for (const track of tracks)
      if (trackProfileProblems(m.profile, track).problems.length)
        throw new AgentError(`Verify the ${track} profile first`);
    if (m.profile.resumeSha256 !== m.resumeHash)
      throw new AgentError("Resume is not approved");
    if (body.action === "enable-pilot") {
      if (typeof body.batchId !== "string" || typeof body.jobId !== "string")
        throw new AgentError("Select an approved pilot batch and job", 400);
      await checkedBatchItem(env, body.batchId, body.jobId);
      await setSetting(env, "agent_pilot_job", body.jobId);
      await setSetting(env, "agent_submissions_enabled", "true");
      return {
        pilotEnabled: true,
        jobId: body.jobId,
        dailyEmailUnchanged: true,
      };
    }
    const pilot = await setting(env, "agent_pilot_job", "");
    if (
      !pilot ||
      !(await env.DB.prepare(
        "SELECT id FROM attempts WHERE job_id=? AND state='confirmed' AND runner='muse'",
      )
        .bind(pilot)
        .first())
    )
      throw new AgentError(
        "Complete and confirm the selected real Muse pilot application before full launch",
      );
    await setSetting(env, "agent_pilot_job", "");
    await env.DB.batch(
      ["agent_submissions_enabled", "agent_launched"].map((key) =>
        env.DB.prepare("UPDATE settings SET value='true' WHERE key=?").bind(
          key,
        ),
      ),
    );
    await setSetting(env, "email_enabled", "false");
    await setSetting(env, "apply_enabled", "false");
    return {
      launched: true,
      emailEnabled: false,
      scheduledApplications: false,
    };
  }
  if (body.action === "disable-submissions") {
    await setSetting(env, "agent_submissions_enabled", "false");
    return { submissionEnabled: false };
  }
  if (body.action === "reconcile-confirmed") {
    if (
      typeof body.attemptId !== "string" ||
      typeof body.text !== "string" ||
      !/application.{0,60}(submitted|received)|thank you for applying/i.test(
        body.text,
      ) ||
      typeof body.observedAt !== "string" ||
      !Number.isFinite(Date.parse(body.observedAt))
    )
      throw new AgentError(
        "Provide the owner-observed confirmation text, URL, and application time",
        400,
      );
    postingUrl(body.url);
    const a = await env.DB.prepare("SELECT * FROM attempts WHERE id=?")
      .bind(body.attemptId)
      .first<ApplicationAttempt>();
    if (!a?.batch_id || !["uncertain", "submitting"].includes(a.state))
      throw new AgentError(
        "Only a pending/uncertain batch attempt can be confirmed this way",
      );
    const { data } = await batch(env, a.batch_id);
    const item = data.items.find((j) => j.jobId === a.job_id);
    if (
      !item ||
      ![new URL(item.url).hostname, new URL(item.applyUrl).hostname].includes(
        new URL(body.url).hostname,
      )
    )
      throw new AgentError(
        "Confirmation URL must match the reviewed application host",
      );
    await env.DB.prepare(
      "UPDATE attempts SET state='confirmed',finished_at=?,error=NULL,evidence=? WHERE id=? AND state=?",
    )
      .bind(
        body.observedAt,
        JSON.stringify({
          source: "Owner-reported confirmation",
          prior: a.evidence,
          confirmation: { text: body.text.slice(0, 4000), url: body.url },
        }),
        a.id,
        a.state,
      )
      .run();
    return syncResult(env, {
      ...a,
      state: "confirmed",
      finished_at: body.observedAt,
    });
  }
  if (body.action === "reconcile-not-submitted") {
    if (
      typeof body.attemptId !== "string" ||
      typeof body.evidence !== "string" ||
      body.evidence.trim().length < 10
    )
      throw new AgentError(
        "Provide the attempt ID and owner-checked evidence that no submission occurred",
        400,
      );
    const a = await env.DB.prepare("SELECT * FROM attempts WHERE id=?")
      .bind(body.attemptId)
      .first<ApplicationAttempt>();
    if (
      !a ||
      !["uncertain", "preview", "blocked", "preparing"].includes(a.state)
    )
      throw new AgentError("Attempt cannot be released");
    await env.DB.prepare(
      "UPDATE attempts SET state='blocked',error=?,job_id=job_id || ':history:' || id,identity=NULL,finished_at=? WHERE id=? AND state=?",
    )
      .bind(`Owner reconciled: ${body.evidence}`, now(), a.id, a.state)
      .run();
    if (a.batch_id)
      await syncResult(env, {
        ...a,
        state: "blocked",
        error: body.evidence,
        finished_at: now(),
      });
    return {
      released: true,
      attemptId: a.id,
      evidenceSource: "owner reconciliation",
    };
  }
  throw new AgentError("Unknown agent configuration action", 400);
}
