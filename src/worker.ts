import companySources from "./company-sources.json";
import { applyJob, jobFingerprint } from "./applications";
import { digestContent, sendDigest } from "./digest";
import { Notion } from "./notion";
import { rank, roleLane } from "./matching";
import { scan, syncJob } from "./pipeline";
import { duplicate, event, importPages, setSetting, setting } from "./store";
import { profileProblems } from "./forms";
import type { Env, Profile, Source, Task } from "./types";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function auth(request: Request, env: Env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const given = request.headers.get("authorization") ?? "";
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([
    digest(given),
    digest(`Bearer ${env.ADMIN_TOKEN}`),
  ]);
  return a.reduce((x, v, i) => x | (v ^ b[i]), 0) === 0;
}
async function bootstrap(env: Env) {
  const rows = (companySources as Source[]).map((source) => ({
    id: source.id,
    data: JSON.stringify(source),
    error: source.ats === "manual" ? "Manual career-site check required" : null,
  }));
  await env.DB.prepare(
    "INSERT INTO sources(id,data,last_error) SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.error') FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  )
    .bind(JSON.stringify(rows))
    .run();
}
async function importNotion(env: Env) {
  await setSetting(env, "imported_at", "");
  const pages = await new Notion(env).pages();
  await importPages(env, pages);
}
export async function handleTask(env: Env, task: Task) {
  switch (task.type) {
    case "scan":
      return scan(env, task.sourceId);
    case "sync":
      return syncJob(env, task.jobId);
    case "apply":
      return applyJob(env, task.jobId, task.dryRun);
    case "categorize":
      return new Notion(env).setLane(task.pageId, task.lane);
    case "digest":
      return sendDigest(env);
    case "import":
      return importNotion(env);
  }
}
export async function scheduled(env: Env, cron: string) {
  if ((await setting(env, "paused")) === "true") return;
  if (cron === "17 */6 * * *") {
    // Refresh user decisions before adding or applying to any discovered opening.
    try {
      await importNotion(env);
    } catch (e) {
      await event(
        env,
        "notion_import_failure",
        "Discovery continues; syncing and applications wait for a successful import",
      );
    }
    for (const s of companySources as Source[])
      if (s.ats !== "manual")
        await env.TASKS.send({ type: "scan", sourceId: s.id });
  } else {
    await env.TASKS.send({ type: "digest" });
    if ((await setting(env, "apply_enabled")) === "true") {
      const imported = await setting(env, "imported_at", "");
      if (!imported || Date.now() - Date.parse(imported) > 7 * 3600000) return;
      const candidates = await env.DB.prepare(
        "SELECT id FROM jobs WHERE fit='Strong' AND open=1 AND notion_id IS NOT NULL AND automation IN ('Ready','Review') AND NOT EXISTS(SELECT 1 FROM attempts WHERE attempts.job_id=jobs.id) ORDER BY baseline ASC,first_seen DESC LIMIT 3",
      ).all<{ id: string }>();
      for (const j of candidates.results)
        await env.TASKS.send({ type: "apply", jobId: j.id });
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await auth(request, env)))
      return json({ error: "Unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/status")
        return json({
          settings: (await env.DB.prepare("SELECT * FROM settings").all())
            .results,
          counts: (
            await env.DB.prepare(
              "SELECT fit,COUNT(*) AS count FROM jobs GROUP BY fit",
            ).all()
          ).results,
          sources: (
            await env.DB.prepare(
              "SELECT id,last_success,last_error FROM sources",
            ).all()
          ).results,
          attempts: (
            await env.DB.prepare(
              "SELECT id,job_id,state,started_at,finished_at,error FROM attempts ORDER BY started_at DESC LIMIT 20",
            ).all()
          ).results,
          digests: (
            await env.DB.prepare(
              "SELECT * FROM digest ORDER BY local_day DESC LIMIT 5",
            ).all()
          ).results,
          connections: {
            notion: !!env.NOTION_TOKEN,
            email: !!env.BREVO_API_KEY && !!env.BREVO_SENDER,
            profile: !!(await env.DB.prepare(
              "SELECT key FROM private_data WHERE key='profile'",
            ).first()),
          },
        });
      if (request.method === "GET" && path === "/existing")
        return json(
          (
            await env.DB.prepare(
              "SELECT id,company,title,stage,source,archived FROM existing_pages ORDER BY company,title",
            ).all()
          ).results,
        );
      if (request.method === "GET" && path === "/shortlist") {
        const rows = await env.DB.prepare(
          "SELECT id,data,fit,reasons,first_seen,baseline FROM jobs WHERE open=1 AND fit<>'Skip'",
        ).all<{
          id: string;
          data: string;
          fit: string;
          reasons: string;
          first_seen: string;
          baseline: number;
        }>();
        const results = [] as unknown[];
        for (const row of rows.results) {
          const job = JSON.parse(row.data);
          const fit = rank(job);
          if (!fit.bayArea) continue;
          const existing = await duplicate(
            env,
            [job.url, job.applyUrl],
            job.company,
            job.title,
          );
          if (existing) continue;
          results.push({
            id: row.id,
            company: job.company,
            title: job.title,
            location: job.location,
            url: job.url,
            applyUrl: job.applyUrl,
            fit: row.fit,
            reasons: JSON.parse(row.reasons),
            firstFound: row.first_seen,
            baseline: !!row.baseline,
            priority: fit.priority,
          });
        }
        return json(
          (results as any[])
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 25),
        );
      }
      if (request.method === "GET" && path === "/preview")
        return json(
          (
            await env.DB.prepare(
              "SELECT * FROM jobs WHERE fit<>'Skip' ORDER BY fit DESC,first_seen DESC",
            ).all()
          ).results,
        );
      if (request.method === "GET" && path === "/digest-preview")
        return new Response(
          await digestContent(
            env,
            new Date(Date.now() - 86400000).toISOString(),
          ),
          {
            headers: {
              "Content-Type": "text/html;charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'",
            },
          },
        );
      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      const body = (await request.json()) as any;
      if (path === "/setup") {
        await bootstrap(env);
        if (env.NOTION_TOKEN) {
          await new Notion(env).schema();
          await importNotion(env);
        }
        return json({ ok: true, paused: true });
      }
      if (path === "/categorize") {
        await importNotion(env);
        const pages = await env.DB.prepare(
          "SELECT id,title FROM existing_pages WHERE archived=0",
        ).all<{ id: string; title: string }>();
        for (const page of pages.results)
          await env.TASKS.send({
            type: "categorize",
            pageId: page.id,
            lane: roleLane(page.title),
          });
        return json({ queued: pages.results.length });
      }
      if (path === "/settings") {
        for (const [key, value] of Object.entries(body)) {
          if (
            ![
              "paused",
              "sync_enabled",
              "email_enabled",
              "apply_enabled",
            ].includes(key) ||
            typeof value !== "boolean"
          )
            return json({ error: "Unknown setting or non-boolean value" }, 400);
          if (value && key === "apply_enabled") {
            const p = await env.DB.prepare(
              "SELECT data FROM private_data WHERE key='profile'",
            ).first<{ data: string }>();
            if (!p || profileProblems(JSON.parse(p.data)).length)
              return json(
                {
                  error:
                    "Verify the application profile before enabling submissions",
                },
                409,
              );
          }
        }
        for (const [key, value] of Object.entries(body)) {
          await setSetting(env, key, String(value));
          if (key === "sync_enabled" && value)
            await setSetting(env, "sync_enabled_at", new Date().toISOString());
        }
        return json({ ok: true });
      }
      if (path === "/profile") {
        const p = body.profile as Profile;
        if (
          !p ||
          typeof p.verified !== "boolean" ||
          p.earliestStart !== "2027-06-01" ||
          !p.answers ||
          !Array.isArray(p.approvedJobIds) ||
          typeof body.resumeBase64 !== "string" ||
          body.resumeBase64.length > 1500000
        )
          return json({ error: "Invalid profile or resume" }, 400);
        if (p.verified && profileProblems(p).length)
          return json({ error: profileProblems(p) }, 400);
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO private_data(key,data) VALUES('profile',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
          ).bind(JSON.stringify(p)),
          env.DB.prepare(
            "INSERT INTO private_data(key,data) VALUES('resume',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
          ).bind(body.resumeBase64),
        ]);
        await setSetting(env, "apply_enabled", "false");
        await env.DB.prepare(
          "UPDATE jobs SET automation='Review' WHERE automation='Held'",
        ).run();
        return json({ ok: true, submissionsDisabled: true });
      }
      if (path === "/run") {
        if (body.type === "scan") {
          await bootstrap(env);
          if (env.NOTION_TOKEN) await importNotion(env);
          for (const s of companySources as Source[])
            if (s.ats !== "manual")
              await env.TASKS.send({ type: "scan", sourceId: s.id });
        } else if (body.type === "sync") {
          await importNotion(env);
          const rows = await env.DB.prepare(
            "SELECT id FROM jobs WHERE fit<>'Skip' AND open=1 AND notion_id IS NULL AND baseline=0 AND first_seen>?",
          )
            .bind(
              await setting(env, "sync_enabled_at", "9999-12-31T00:00:00.000Z"),
            )
            .all<{ id: string }>();
          for (const j of rows.results)
            await env.TASKS.send({ type: "sync", jobId: j.id });
        } else if (body.type === "sync-shortlist") {
          await importNotion(env);
          const rows = await env.DB.prepare(
            "SELECT id,data FROM jobs WHERE open=1 AND fit<>'Skip'",
          ).all<{ id: string; data: string }>();
          const selected = [] as { id: string; priority: number }[];
          for (const row of rows.results) {
            const job = JSON.parse(row.data);
            const fit = rank(job);
            if (
              !fit.bayArea ||
              (await duplicate(
                env,
                [job.url, job.applyUrl],
                job.company,
                job.title,
              ))
            )
              continue;
            selected.push({ id: row.id, priority: fit.priority });
          }
          for (const row of selected
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 25))
            await env.TASKS.send({ type: "sync", jobId: row.id });
        } else if (body.type === "digest")
          await env.TASKS.send({ type: "digest" });
        else if (body.type === "apply" && typeof body.jobId === "string")
          await env.TASKS.send({
            type: "apply",
            jobId: body.jobId,
            dryRun: body.dryRun !== false,
          });
        else return json({ error: "Unsupported task" }, 400);
        return json({ queued: true }, 202);
      }
      if (path === "/reconcile") {
        if (typeof body.jobId !== "string")
          return json({ error: "Job ID required" }, 400);
        if (
          body.action === "attach-notion" &&
          typeof body.pageId === "string"
        ) {
          const p = await new Notion(env).page(body.pageId);
          if (p.parent?.data_source_id !== env.NOTION_DATA_SOURCE_ID)
            return json({ error: "Wrong Notion data source" }, 400);
          await env.DB.prepare(
            "UPDATE jobs SET notion_id=?,automation='Review',needs_input=1 WHERE id=?",
          )
            .bind(p.id, body.jobId)
            .run();
          await env.DB.prepare(
            "UPDATE sync_writes SET state='reconciled',page_id=? WHERE job_id=?",
          )
            .bind(p.id, body.jobId)
            .run();
        } else if (body.action === "retry-pre-submit") {
          const attempt = await env.DB.prepare(
            "SELECT state FROM attempts WHERE job_id=?",
          )
            .bind(body.jobId)
            .first<{ state: string }>();
          if (!attempt || !["blocked", "preview"].includes(attempt.state))
            return json(
              { error: "Only a confirmed pre-submission stop may be retried" },
              409,
            );
          // Keep the reservation for daily accounting, release only the job-specific uniqueness key.
          await env.DB.prepare(
            "UPDATE attempts SET job_id=job_id || ':history:' || id WHERE job_id=?",
          )
            .bind(body.jobId)
            .run();
        } else
          return json(
            {
              error:
                "Unsupported reconciliation; uncertain submissions cannot be retried automatically",
            },
            400,
          );
        await event(
          env,
          "manual_reconciliation",
          `${body.action}: ${body.jobId}`,
        );
        return json({ ok: true });
      }
      if (path === "/approve-role") {
        if (typeof body.jobId !== "string" || body.reviewed !== true)
          return json({ error: "Explicit review confirmation required" }, 400);
        const j = await env.DB.prepare("SELECT data FROM jobs WHERE id=?")
          .bind(body.jobId)
          .first<{ data: string }>();
        const p = await env.DB.prepare(
          "SELECT data FROM private_data WHERE key='profile'",
        ).first<{ data: string }>();
        if (!j || !p)
          return json({ error: "Job and verified profile must exist" }, 409);
        const profile: Profile = JSON.parse(p.data);
        if (profileProblems(profile).length)
          return json({ error: "Profile is not verified" }, 409);
        profile.approvedJobIds = [
          ...new Set([...profile.approvedJobIds, body.jobId]),
        ];
        profile.approvedJobHashes = {
          ...profile.approvedJobHashes,
          [body.jobId]: await jobFingerprint(JSON.parse(j.data)),
        };
        await env.DB.prepare(
          "UPDATE private_data SET data=? WHERE key='profile'",
        )
          .bind(JSON.stringify(profile))
          .run();
        await env.DB.prepare("UPDATE jobs SET automation='Ready' WHERE id=?")
          .bind(body.jobId)
          .run();
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Request failed" },
        500,
      );
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(scheduled(env, controller.cron));
  },
  async queue(batch: MessageBatch<Task>, env: Env) {
    for (const m of batch.messages) {
      try {
        await handleTask(env, m.body);
        m.ack();
      } catch (e) {
        await event(
          env,
          "task_failure",
          `${m.body.type}: ${e instanceof Error ? e.message : "failed"}`,
        );
        m.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, Task>;
