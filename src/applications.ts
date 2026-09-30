import type { launch as Launch } from "@cloudflare/playwright";
import { planFields, profileProblems, type Field } from "./forms";
import { rank } from "./matching";
import { Notion, fromPage } from "./notion";
import { fetchJobs } from "./sources";
import { event, jobRow, lock, referralHold, setting, unlock } from "./store";
import type { Env, Job, Profile, Source } from "./types";

export function safeApplyUrl(job: Job): boolean {
  try {
    const u = new URL(job.applyUrl);
    const p = u.pathname.split("/").filter(Boolean);
    return (
      u.protocol === "https:" &&
      u.hostname === "jobs.ashbyhq.com" &&
      p.length >= 2 &&
      job.id === `ashby:${p[0].toLowerCase()}:${p[1]}`
    );
  } catch {
    return false;
  }
}
export function qualificationHolds(job: Job, profile: Profile): string[] {
  if (profile.approvedJobIds.includes(job.id)) return [];
  const holds: string[] = [];
  const required =
    job.description.match(
      /(?:must have|required qualifications|minimum qualifications|requirements|you have)[^.]{0,1500}/gi,
    ) ?? [];
  if (!required.length)
    holds.push(
      "Required qualifications need review; no clearly identified requirements section",
    );
  for (const clause of required) {
    if (
      /citizen|security clearance|ph\.?d|doctorate|c\+\+|cuda|rust|kubernetes|production.*(?:deploy|infrastructure)/i.test(
        clause,
      )
    )
      holds.push("Required qualification is not verified in the profile");
    const years = clause.match(/(\d+)\+?\s*years?/i);
    if (years) {
      const experience = profile.answers.professionalYears;
      if (!experience?.verified || Number(experience.value) < Number(years[1]))
        holds.push("Verify professional experience requirement");
    }
    // Full requirement text must be explicitly reviewed once unless it is an exact approved clause.
    if (!profile.answers[`qualification:${clause.trim()}`]?.verified)
      holds.push("Review the employer’s complete required qualifications");
  }
  return [...new Set(holds)];
}
async function hold(
  env: Env,
  id: string,
  pageId: string | null,
  reason: string,
) {
  await env.DB.prepare(
    "UPDATE jobs SET automation='Held',needs_input=1 WHERE id=?",
  )
    .bind(id)
    .run();
  await event(env, "application_review", `${id}: ${reason}`);
  if (pageId && env.NOTION_TOKEN) {
    const notion = new Notion(env);
    await notion.setAutomation(pageId, "Review", true);
    await notion.note(pageId, reason);
  }
}
export async function jobFingerprint(job: Job) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([job.title, job.description, job.location, job.applyUrl]),
    ),
  );
  return Array.from(new Uint8Array(bytes))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function applyJob(
  env: Env,
  id: string,
  dryRun = false,
  browserLauncher?: typeof Launch,
) {
  if ((await setting(env, "paused")) === "true") return;
  if (!dryRun && (await setting(env, "apply_enabled")) !== "true") return;
  const row = await jobRow(env, id);
  if (!row || !row.notion_id || !row.open) return;
  const job: Job = JSON.parse(row.data),
    fit = rank(job);
  if (
    fit.label !== "Strong" ||
    !fit.bayArea ||
    job.ats !== "ashby" ||
    !safeApplyUrl(job)
  )
    return hold(
      env,
      id,
      row.notion_id,
      "Only strong Bay Area matches on supported Ashby forms are eligible",
    );
  const profileRecord = await env.DB.prepare(
    "SELECT data FROM private_data WHERE key='profile'",
  ).first<{ data: string }>();
  const resumeRecord = await env.DB.prepare(
    "SELECT data FROM private_data WHERE key='resume'",
  ).first<{ data: string }>();
  if (!profileRecord || !resumeRecord)
    return hold(
      env,
      id,
      row.notion_id,
      "Approved profile and resume are not configured",
    );
  const profile: Profile = JSON.parse(profileRecord.data);
  const issues = [
    ...profileProblems(profile),
    ...qualificationHolds(job, profile),
  ];
  if (
    profile.approvedJobIds.includes(id) &&
    profile.approvedJobHashes?.[id] !== (await jobFingerprint(job))
  )
    issues.push("Role approval is missing or the reviewed posting has changed");
  if (await referralHold(env, job.company))
    issues.push("Referral opportunity: review before submission");
  if (issues.length) return hold(env, id, row.notion_id, issues.join("; "));
  const resume = Uint8Array.from(atob(resumeRecord.data), (c) =>
    c.charCodeAt(0),
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", resume)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== profile.resumeSha256)
    return hold(
      env,
      id,
      row.notion_id,
      "Resume fingerprint does not match approved file",
    );
  const notion = new Notion(env);
  const page = await notion.page(row.notion_id);
  const existing = fromPage(page);
  if (existing.archived || existing.stage !== "To apply") return;
  const auto = page.properties["Automation Status"]?.select?.name;
  if (["Paused", "Submitted", "Uncertain", "Closed"].includes(auto)) return;
  const content = await notion.content(row.notion_id);
  if (/referral|refer me|referred by|introduction/i.test(content))
    return hold(env, id, row.notion_id, "Referral note on application page");
  const sourceData = await env.DB.prepare("SELECT data FROM sources WHERE id=?")
    .bind(job.sourceId)
    .first<{ data: string }>();
  if (!sourceData) return;
  const fresh = (await fetchJobs(JSON.parse(sourceData.data) as Source)).find(
    (j) => j.id === id && j.listed,
  );
  if (!fresh) {
    await env.DB.prepare(
      "UPDATE jobs SET open=0,automation='Closed' WHERE id=?",
    )
      .bind(id)
      .run();
    return hold(env, id, row.notion_id, "Posting is no longer available");
  }
  if (
    fresh.description !== job.description ||
    fresh.title !== job.title ||
    fresh.location !== job.location
  )
    return hold(
      env,
      id,
      row.notion_id,
      "Posting changed since qualification review",
    );
  const owner = await lock(env, "browser", 240);
  if (!owner) return;
  let browser: Awaited<ReturnType<typeof Launch>> | undefined,
    attemptId: string | undefined,
    submitted = false;
  const started = new Date().toISOString();
  try {
    const day = started.slice(0, 10);
    const budget = await env.DB.prepare(
      "SELECT COUNT(*) AS count,COALESCE(SUM(reserved_seconds),0) AS seconds FROM attempts WHERE substr(started_at,1,10)=?",
    )
      .bind(day)
      .first<{ count: number; seconds: number }>();
    if ((budget?.count ?? 0) >= 3 || (budget?.seconds ?? 0) + 180 > 540) {
      await event(
        env,
        "browser_limit",
        "Daily budget reached; remaining applications need manual work or a later day",
      );
      return;
    }
    if (
      await env.DB.prepare("SELECT id FROM attempts WHERE job_id=?")
        .bind(id)
        .first()
    )
      return;
    attemptId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO attempts(id,job_id,state,started_at,reserved_seconds) VALUES(?,?,'preparing',?,180)",
    )
      .bind(attemptId, id, started)
      .run();
    const launchBrowser =
      browserLauncher ?? (await import("@cloudflare/playwright")).launch;
    browser = await launchBrowser(env.BROWSER, { keep_alive: 180000 });
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.setDefaultTimeout(10000);
    // Every attempt reserves three minutes even after a crash. Provider idle expiry is a second limit.
    const deadline = setTimeout(() => {
      void browser?.close();
    }, 165000);
    try {
      await tab.goto(job.applyUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });
      const applicationTab = tab.getByRole("tab", {
        name: "Application",
        exact: true,
      });
      if (await applicationTab.count()) await applicationTab.click();
      await tab
        .locator('input[type="email"], input[autocomplete="email"]')
        .first()
        .waitFor({ timeout: 15000 });
      if (new URL(tab.url()).hostname !== "jobs.ashbyhq.com")
        throw new Error("Application redirected to an unsupported host");
      if (
        await tab
          .locator(
            'iframe[src*="captcha"], [data-sitekey], input[type="password"]',
          )
          .count()
      )
        throw new Error("CAPTCHA or account login requires manual completion");
      const fields: Field[] = await tab
        .locator('input,textarea,select,[role="combobox"]')
        .evaluateAll((elements) =>
          elements
            .map((element, index) => {
              const e = element as HTMLInputElement;
              const visible = !!(
                e.offsetWidth ||
                e.offsetHeight ||
                e.getClientRects().length
              );
              if (!visible && e.type !== "file") return null;
              if (
                e.disabled ||
                ["hidden", "submit", "button", "reset"].includes(e.type)
              )
                return null;
              const label =
                [...(e.labels ?? [])]
                  .map((l) => l.textContent ?? "")
                  .join(" ")
                  .trim() ||
                e.getAttribute("aria-label") ||
                document.getElementById(e.getAttribute("aria-labelledby") ?? "")
                  ?.textContent ||
                "";
              return {
                index,
                label: label.trim(),
                type:
                  e.tagName === "SELECT"
                    ? "select"
                    : e.tagName === "TEXTAREA"
                      ? "textarea"
                      : e.getAttribute("role") === "combobox"
                        ? "custom"
                        : e.type,
                required:
                  e.required ||
                  e.getAttribute("aria-required") === "true" ||
                  label.includes("*"),
                options:
                  e.tagName === "SELECT"
                    ? [...(e as unknown as HTMLSelectElement).options].map(
                        (o) => o.text,
                      )
                    : undefined,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null),
        );
      const plan = planFields(fields, profile);
      if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
      for (const fill of plan.fills) {
        const field = tab
          .locator('input,textarea,select,[role="combobox"]')
          .nth(fill.index);
        if (fill.kind === "file")
          await field.setInputFiles({
            name: "resume.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from(resume),
          });
        else if (fill.kind === "select")
          await field.selectOption({ label: fill.value });
        else if (fill.kind === "check") await field.check();
        else await field.fill(fill.value);
      }
      if (dryRun) {
        await env.DB.prepare(
          "UPDATE attempts SET state='preview',finished_at=?,evidence=? WHERE id=?",
        )
          .bind(
            new Date().toISOString(),
            JSON.stringify({
              fields: fields.map((f) => f.label),
              filled: plan.fills.length,
            }),
            attemptId,
          )
          .run();
        await event(
          env,
          "application_preview",
          `${id}: filled ${plan.fills.length} fields; did not submit`,
        );
        return;
      }
      const latest = await notion.page(row.notion_id);
      if (
        fromPage(latest).stage !== "To apply" ||
        latest.archived ||
        latest.in_trash ||
        (await setting(env, "paused")) === "true" ||
        (await setting(env, "apply_enabled")) !== "true"
      )
        throw new Error("Application paused or Notion status changed");
      if (
        ["Paused", "Closed", "Submitted", "Uncertain"].includes(
          latest.properties["Automation Status"]?.select?.name,
        )
      )
        throw new Error("Notion automation is on hold");
      await env.DB.prepare("UPDATE attempts SET state='submitting' WHERE id=?")
        .bind(attemptId)
        .run();
      submitted = true;
      await tab.getByRole("button", { name: /^submit application$/i }).click();
      await tab
        .getByText(
          /application (?:has been )?(?:successfully )?(?:submitted|received)|thank you for applying/i,
        )
        .first()
        .waitFor({ timeout: 20000 });
      const when = new Date().toISOString();
      const evidence = JSON.stringify({
        url: tab.url(),
        confirmedAt: when,
        confirmation: await tab
          .getByText(
            /application (?:has been )?(?:successfully )?(?:submitted|received)|thank you for applying/i,
          )
          .first()
          .innerText(),
      });
      await env.DB.prepare(
        "UPDATE attempts SET state='confirmed',finished_at=?,evidence=? WHERE id=?",
      )
        .bind(when, evidence, attemptId)
        .run();
      await env.DB.prepare(
        "UPDATE jobs SET automation='Submitted',needs_input=0 WHERE id=?",
      )
        .bind(id)
        .run();
      try {
        await notion.submitted(row.notion_id, when);
      } catch {
        await event(
          env,
          "submission_sync",
          "Confirmed submission needs Notion reconciliation: " + id,
        );
      }
    } finally {
      clearTimeout(deadline);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Application failed";
    if (attemptId)
      await env.DB.prepare(
        "UPDATE attempts SET state=?,finished_at=?,error=? WHERE id=?",
      )
        .bind(
          submitted ? "uncertain" : "blocked",
          new Date().toISOString(),
          reason.slice(0, 1000),
          attemptId,
        )
        .run();
    await env.DB.prepare(
      "UPDATE jobs SET automation=?,needs_input=1 WHERE id=?",
    )
      .bind(submitted ? "Uncertain" : "Review", id)
      .run();
    await event(
      env,
      submitted ? "submission_uncertain" : "application_review",
      `${id}: ${reason}`,
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await unlock(env, "browser", owner);
    }
  }
}
