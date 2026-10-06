import { fetchJobs } from "./sources";
import { rank } from "./matching";
import { Notion } from "./notion";
import {
  duplicate,
  event,
  jobRow,
  lock,
  referralHold,
  setting,
  unlock,
} from "./store";
import type { Env, Job, Source } from "./types";
export async function scan(env: Env, sourceId: string) {
  if ((await setting(env, "paused")) === "true") return;
  const entry = await env.DB.prepare("SELECT * FROM sources WHERE id=?")
    .bind(sourceId)
    .first<{ data: string; initialized: number }>();
  if (!entry) throw new Error("Unknown source");
  const source: Source = JSON.parse(entry.data);
  if (source.ats === "manual") return;
  const owner = await lock(env, `scan:${sourceId}`, 900);
  if (!owner) return;
  try {
    const jobs = await fetchJobs(source);
    const now = new Date().toISOString();
    const tracked = new Set(
      (
        await env.DB.prepare("SELECT id FROM jobs WHERE source_id=?")
          .bind(source.id)
          .all<{ id: string }>()
      ).results.map((j) => j.id),
    );
    const relevant = jobs
      .map((job) => ({ job, fit: rank(job) }))
      .filter(({ job, fit }) => fit.earlyCareerVerified || tracked.has(job.id));
    if (relevant.length > 400)
      throw new Error(
        "Source exceeds the free-tier processing batch; manual check required",
      );
    const writes: D1PreparedStatement[] = [];
    for (let start = 0; start < relevant.length; start += 20) {
      const rows = relevant.slice(start, start + 20).map(({ job, fit }) => ({
        id: job.id,
        source_id: source.id,
        data: JSON.stringify(job),
        fit: fit.label,
        reasons: JSON.stringify(fit.reasons),
        first_seen: now,
        last_seen: now,
        baseline: +!entry.initialized,
        open: +job.listed,
      }));
      writes.push(
        env.DB.prepare(
          "INSERT INTO jobs(id,source_id,data,fit,reasons,first_seen,last_seen,baseline,open) SELECT json_extract(value,'$.id'),json_extract(value,'$.source_id'),json_extract(value,'$.data'),json_extract(value,'$.fit'),json_extract(value,'$.reasons'),json_extract(value,'$.first_seen'),json_extract(value,'$.last_seen'),json_extract(value,'$.baseline'),json_extract(value,'$.open') FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET data=excluded.data,fit=excluded.fit,reasons=excluded.reasons,last_seen=excluded.last_seen,open=excluded.open",
        ).bind(JSON.stringify(rows)),
      );
    }
    // Only a completely parsed, successfully persisted feed can close missing jobs.
    writes.push(
      env.DB.prepare(
        "UPDATE jobs SET open=0,automation='Closed',needs_input=1 WHERE source_id=? AND last_seen<>?",
      ).bind(source.id, now),
    );
    writes.push(
      env.DB.prepare(
        "UPDATE sources SET initialized=1,last_success=?,last_error=NULL WHERE id=?",
      ).bind(now, source.id),
    );
    await env.DB.batch(writes);
    // Initial openings are a review baseline. Only roles found after Notion
    // updates were enabled are added automatically; baseline roles are curated.
    const enabledAt = await setting(
      env,
      "sync_enabled_at",
      "9999-12-31T00:00:00.000Z",
    );
    const pending = await env.DB.prepare(
      "SELECT id FROM jobs WHERE source_id=? AND open=1 AND fit<>'Skip' AND notion_id IS NULL AND baseline=0 AND first_seen>?",
    )
      .bind(source.id, enabledAt)
      .all<{ id: string }>();
    if ((await setting(env, "sync_enabled")) === "true")
      for (const j of pending.results)
        await env.TASKS.send({ type: "sync", jobId: j.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed";
    await env.DB.prepare("UPDATE sources SET last_error=? WHERE id=?")
      .bind(message, source.id)
      .run();
    await event(env, "source_failure", `${source.company}: ${message}`);
    throw e;
  } finally {
    await unlock(env, `scan:${sourceId}`, owner);
  }
}
export async function syncJob(env: Env, id: string) {
  if (
    (await setting(env, "paused")) === "true" ||
    (await setting(env, "sync_enabled")) !== "true"
  )
    return;
  const imported = await setting(env, "imported_at", "");
  if (!imported || Date.now() - Date.parse(imported) > 7 * 3600000)
    throw new Error("Fresh Notion import required before sync");
  const row = await jobRow(env, id);
  if (!row || row.notion_id || !row.open || row.fit === "Skip") return;
  const currentFit = rank(JSON.parse(row.data));
  if (!currentFit.earlyCareerVerified || currentFit.label === "Skip") return;
  const owner = await lock(env, `sync:${id}`);
  if (!owner) return;
  try {
    const job: Job = JSON.parse(row.data),
      found = await duplicate(
        env,
        [job.url, job.applyUrl],
        job.company,
        job.title,
      );
    if (found) {
      await env.DB.prepare(
        "UPDATE jobs SET notion_id=?,automation=?,needs_input=? WHERE id=?",
      )
        .bind(
          found.id,
          found.ambiguous ? "Review" : "Existing",
          +found.ambiguous,
          id,
        )
        .run();
      return;
    }
    const previous = await env.DB.prepare(
      "SELECT state FROM sync_writes WHERE job_id=?",
    )
      .bind(id)
      .first();
    if (previous) {
      await event(
        env,
        "sync_review",
        `Notion creation requires reconciliation: ${id}`,
      );
      return;
    }
    await env.DB.prepare(
      "INSERT INTO sync_writes(job_id,state) VALUES(?,'creating')",
    )
      .bind(id)
      .run();
    const notion = new Notion(env);
    const page = await notion.create(
      job,
      currentFit,
      row.first_seen,
      !!row.baseline,
      `Job identity: ${id}`,
    );
    await env.DB.prepare(
      "UPDATE sync_writes SET state='created',page_id=? WHERE job_id=?",
    )
      .bind(page.id, id)
      .run();
    await env.DB.prepare(
      "UPDATE jobs SET notion_id=?,automation='Review',needs_input=1 WHERE id=?",
    )
      .bind(page.id, id)
      .run();
    await event(
      env,
      "notion_created",
      `${job.company}: ${job.title}${(await referralHold(env, job.company)) ? " — referral hold" : ""}`,
    );
  } catch (e) {
    await env.DB.prepare(
      "UPDATE sync_writes SET state='uncertain',error=? WHERE job_id=?",
    )
      .bind(e instanceof Error ? e.message : "Sync error", id)
      .run();
    throw e;
  } finally {
    await unlock(env, `sync:${id}`, owner);
  }
}
