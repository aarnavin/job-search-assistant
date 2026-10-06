import type { Env, Job, JobRow } from "./types";
import { setting } from "./store";
import { rank } from "./matching";
import { companyKey, identities, plainTitle } from "./identity";
export function localClock(now: Date, zone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export async function digestContent(env: Env, since: string) {
  const jobs = await env.DB.prepare(
    "SELECT * FROM jobs WHERE open=1 ORDER BY first_seen DESC",
  ).all<JobRow>();
  const existing = await env.DB.prepare(
    "SELECT id,company,title,stage,links FROM existing_pages WHERE archived=0",
  ).all<{
    id: string;
    company: string;
    title: string;
    stage: string;
    links: string;
  }>();
  const completed = existing.results.filter(
    (p) => p.stage && p.stage !== "To apply",
  );
  const completedIds = new Set(completed.map((p) => p.id));
  const completedLinks = new Set(
    completed.flatMap((p) => identities(JSON.parse(p.links))),
  );
  const completedTitles = new Set(
    completed.map((p) => companyKey(p.company) + ":" + plainTitle(p.title)),
  );
  const eligible = jobs.results.filter((row) => {
    const job: Job = JSON.parse(row.data);
    const fit = rank(job);
    if (!fit.earlyCareerVerified || fit.label === "Skip") return false;
    if (row.notion_id && completedIds.has(row.notion_id)) return false;
    if (
      identities([job.url, job.applyUrl]).some((id) => completedLinks.has(id))
    )
      return false;
    if (
      completedTitles.has(companyKey(job.company) + ":" + plainTitle(job.title))
    )
      return false;
    return true;
  });
  const submissions = await env.DB.prepare(
    "SELECT job_id,finished_at FROM attempts WHERE state='confirmed' AND finished_at>? ORDER BY finished_at",
  )
    .bind(since)
    .all<{ job_id: string; finished_at: string }>();
  const failures = await env.DB.prepare(
    "SELECT data,last_error,last_success FROM sources WHERE last_error IS NOT NULL OR initialized=0",
  ).all<{
    data: string;
    last_error: string | null;
    last_success: string | null;
  }>();
  const notices = await env.DB.prepare(
    "SELECT kind,detail FROM events WHERE created_at>? ORDER BY id DESC LIMIT 30",
  )
    .bind(since)
    .all<{ kind: string; detail: string }>();
  const strong = eligible.filter(
    (j) =>
      rank(JSON.parse(j.data)).label === "Strong" &&
      !j.baseline &&
      j.first_seen > since,
  );
  const review = eligible.filter(
    (j) =>
      j.notion_id &&
      j.needs_input &&
      !["Submitted", "Existing"].includes(j.automation),
  );
  const link = (r: JobRow) => {
    const j: Job = JSON.parse(r.data);
    return `<li><a href="${escapeHtml(j.url)}">${escapeHtml(j.company + " — " + j.title)}</a> (${escapeHtml(j.location)})${r.notion_id ? ` · <a href="https://www.notion.so/${r.notion_id.replaceAll("-", "")}">Notion</a>` : ""}<br>${escapeHtml(JSON.parse(r.reasons).join("; "))}${r.baseline ? " · Existing opening from baseline" : ""}</li>`;
  };
  return `<h1>Your job search — ${localClock(new Date(), env.TIME_ZONE).day}</h1><h2>Confirmed submissions (${submissions.results.length})</h2><ul>${submissions.results.map((s) => `<li>${escapeHtml(s.job_id)} — ${escapeHtml(s.finished_at)}</li>`).join("")}</ul><h2>Strong new matches (${strong.length})</h2><ul>${strong.slice(0, 30).map(link).join("")}</ul><h2>Needs your input (${review.length})</h2><p>Showing up to 30. Your full queue is in Notion.</p><ul>${review.slice(0, 30).map(link).join("")}</ul><h2>Coverage and failures</h2><ul>${failures.results
    .map((s) => {
      const data = JSON.parse(s.data);
      return `<li>${escapeHtml(data.company)}: ${escapeHtml(data.ats === "manual" ? data.note : (s.last_error ?? "Initial scan not completed"))}</li>`;
    })
    .join("")}</ul><h2>Service notices</h2><ul>${notices.results
    .filter((n) => !["notion_created"].includes(n.kind))
    .map((n) => `<li>${escapeHtml(n.kind + ": " + n.detail)}</li>`)
    .join(
      "",
    )}</ul><p>Start availability: June 1, 2027. A missing posting date is never treated as a new posting.</p>`;
}
export async function sendDigest(env: Env, now = new Date()) {
  if (
    (await setting(env, "paused")) === "true" ||
    (await setting(env, "email_enabled")) !== "true"
  )
    return;
  const clock = localClock(now, env.TIME_ZONE);
  if (clock.hour < 8) return;
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER)
    throw new Error("Brevo credentials or verified sender missing");
  const last = await env.DB.prepare(
    "SELECT sent_at FROM digest WHERE state='sent' ORDER BY sent_at DESC LIMIT 1",
  ).first<{ sent_at: string }>();
  const since =
    last?.sent_at ?? new Date(now.valueOf() - 86400000).toISOString();
  const htmlContent = await digestContent(env, since);
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO digest(local_day,state,since,created_at) VALUES(?,'sending',?,?)",
  )
    .bind(clock.day, since, now.toISOString())
    .run();
  if (!claim.meta.changes) return;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Job search assistant", email: env.BREVO_SENDER },
        to: [{ email: env.DIGEST_EMAIL }],
        subject: `Your job search · ${clock.day}`,
        htmlContent,
      }),
      signal: AbortSignal.timeout(20000),
    });
    // Only explicit rejections are retryable. Timeouts may have delivered an email.
    if (r.status === 429) {
      await env.DB.prepare("DELETE FROM digest WHERE local_day=?")
        .bind(clock.day)
        .run();
      throw new Error("Email rate limited; next schedule will retry");
    }
    if (!r.ok) {
      await env.DB.prepare(
        "UPDATE digest SET state='failed',error=? WHERE local_day=?",
      )
        .bind(`HTTP ${r.status}`, clock.day)
        .run();
      return;
    }
    const result = (await r.json()) as { messageId: string };
    await env.DB.prepare(
      "UPDATE digest SET state='sent',sent_at=?,message_id=? WHERE local_day=?",
    )
      .bind(now.toISOString(), result.messageId, clock.day)
      .run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE digest SET state='uncertain',error=? WHERE local_day=? AND state='sending'",
    )
      .bind(e instanceof Error ? e.message : "Email error", clock.day)
      .run();
    throw e;
  }
}
