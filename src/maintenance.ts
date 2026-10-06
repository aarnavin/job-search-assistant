import type { Env, Existing, Job, JobRow } from "./types";
import { Notion, fromPage } from "./notion";
import { identities } from "./identity";
import { rank } from "./matching";
import { event } from "./store";

type Tracked = Pick<JobRow, "id" | "data" | "notion_id" | "open">;

async function trackedJobs(env: Env): Promise<Tracked[]> {
  return (
    await env.DB.prepare(
      "SELECT id,data,notion_id,open FROM jobs",
    ).all<Tracked>()
  ).results;
}

function linkedJob(page: Existing, jobs: Tracked[]): Tracked | undefined {
  const direct = jobs.find((job) => job.notion_id === page.id);
  if (direct) return direct;
  const pageIds = identities(page.links);
  if (!pageIds.length) return;
  return jobs.find((row) => {
    const job: Job = JSON.parse(row.data);
    return identities([job.url, job.applyUrl]).some((id) =>
      pageIds.includes(id),
    );
  });
}

export function assessListing(page: Existing, jobs: Tracked[]) {
  if (page.archived || page.stage !== "To apply" || !page.title.trim())
    return {
      action: "preserve" as const,
      reason: "History or company watchlist",
    };
  const row = linkedJob(page, jobs);
  if (!row)
    return {
      action: "archive" as const,
      reason: "No employer posting with verified early-career requirements",
    };
  const fit = rank(JSON.parse(row.data));
  if (!row.open)
    return { action: "archive" as const, reason: "Employer posting is closed" };
  if (fit.label === "Skip" || !fit.earlyCareerVerified)
    return { action: "archive" as const, reason: fit.reasons.join("; ") };
  return {
    action: "keep" as const,
    reason:
      fit.reasons.find((reason) =>
        reason.startsWith("Early-career evidence:"),
      ) ?? "Verified",
  };
}

export async function reclassifyJobs(env: Env) {
  const rows = await trackedJobs(env);
  const counts = { Strong: 0, Possible: 0, Skip: 0 };
  for (let start = 0; start < rows.length; start += 40) {
    const writes = rows.slice(start, start + 40).map((row) => {
      const fit = rank(JSON.parse(row.data));
      counts[fit.label]++;
      return env.DB.prepare("UPDATE jobs SET fit=?,reasons=? WHERE id=?").bind(
        fit.label,
        JSON.stringify(fit.reasons),
        row.id,
      );
    });
    await env.DB.batch(writes);
  }
  return { total: rows.length, counts };
}

export async function cleanupPreview(env: Env) {
  const [pages, jobs] = await Promise.all([
    new Notion(env).pages(),
    trackedJobs(env),
  ]);
  const archive: {
    id: string;
    company: string;
    title: string;
    reason: string;
  }[] = [];
  const keep: {
    id: string;
    company: string;
    title: string;
    evidence: string;
  }[] = [];
  let watchlists = 0;
  let history = 0;
  for (const page of pages) {
    if (page.archived) continue;
    if (!page.title.trim()) {
      watchlists++;
      continue;
    }
    if (page.stage !== "To apply") {
      history++;
      continue;
    }
    const assessment = assessListing(page, jobs);
    if (assessment.action === "archive")
      archive.push({
        id: page.id,
        company: page.company,
        title: page.title,
        reason: assessment.reason,
      });
    else if (assessment.action === "keep")
      keep.push({
        id: page.id,
        company: page.company,
        title: page.title,
        evidence: assessment.reason,
      });
  }
  const vals = pages.find(
    (page) =>
      page.company.trim().toLowerCase() === "vals ai" &&
      page.title.includes("Member of Technical Staff") &&
      page.stage === "Applied" &&
      !page.archived,
  );
  return {
    archive,
    keep,
    preserved: { watchlists, history },
    valsToReject: vals ? { id: vals.id, title: vals.title } : null,
  };
}

export async function archiveUnverified(
  env: Env,
  id: string,
  expectedTitle: string,
) {
  const notion = new Notion(env);
  const raw = await notion.page(id);
  if (raw.parent?.data_source_id !== env.NOTION_DATA_SOURCE_ID)
    throw new Error("Page does not belong to the tracker");
  const page = fromPage(raw);
  if (page.title !== expectedTitle)
    throw new Error("Page title changed since cleanup preview");
  const assessment = assessListing(page, await trackedJobs(env));
  if (assessment.action !== "archive")
    return { archived: false, reason: assessment.reason };
  await notion.archive(id);
  await env.DB.prepare(
    "UPDATE jobs SET automation='Unsupported',needs_input=0 WHERE notion_id=?",
  )
    .bind(id)
    .run();
  await event(env, "notion_archived", page.company + ": " + page.title);
  return { archived: true, reason: assessment.reason };
}

export async function rejectVals(env: Env, id: string) {
  const notion = new Notion(env);
  const raw = await notion.page(id);
  if (raw.parent?.data_source_id !== env.NOTION_DATA_SOURCE_ID)
    throw new Error("Page does not belong to the tracker");
  const page = fromPage(raw);
  if (
    page.company.trim().toLowerCase() !== "vals ai" ||
    !page.title.includes("Member of Technical Staff") ||
    page.archived
  )
    throw new Error("Vals AI application page changed");
  if (page.stage === "Rejected") return { changed: false };
  if (page.stage !== "Applied")
    throw new Error("Vals AI stage changed; review before overwriting it");
  await notion.setStage(id, "Rejected");
  await event(env, "stage_updated", "Vals AI: Rejected");
  return { changed: true };
}
