import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTool, configureAgent } from "../src/agent";
import { connectorFetch } from "../src/connector";
import {
  claimApplication,
  fingerprint,
  profileForTrack,
} from "../src/application-state";
import { setSetting } from "../src/store";
import { environment, job, profile } from "./helpers";
import type { Profile } from "../src/types";
import { jobIdentity } from "../src/identity";
import { scheduled } from "../src/worker";

async function fixture(t: any) {
  const e = environment(),
    p = profile();
  p.answers.professionalYears = { value: "1", verified: true };
  p.resumeSha256 = await fingerprint(new TextEncoder().encode("resume"));
  const j = job({
    id: jobIdentity("https://careers.example.com/jobs/123")!,
    sourceId: "manual",
    ats: "manual",
    url: "https://careers.example.com/jobs/123",
    applyUrl: "https://careers.example.com/jobs/123/apply",
  });
  e.db
    .prepare("INSERT INTO private_data VALUES('profile',?)")
    .run(JSON.stringify(p));
  e.db
    .prepare("INSERT INTO private_data VALUES('resume',?)")
    .run(btoa("resume"));
  e.db
    .prepare("INSERT INTO sources(id,data) VALUES('manual',?)")
    .run(JSON.stringify({ id: "manual", company: "Test", ats: "manual" }));
  e.db
    .prepare(
      "INSERT INTO jobs(id,source_id,data,fit,reasons,first_seen,last_seen,baseline,open,notion_id) VALUES(?,'manual',?,'Strong','[]',?,?,0,1,'page')",
    )
    .run(
      j.id,
      JSON.stringify(j),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  e.db
    .prepare("INSERT INTO agent_postings VALUES(?,'full-time','{}','[]',?)")
    .run(j.id, new Date().toISOString());
  await setSetting(e.env, "paused", "false");
  const state = {
    stage: "To apply",
    archived: false,
    referral: false,
    syncFails: false,
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/api.notion.com\//);
    if (String(url).includes("/children"))
      return Response.json({
        results: state.referral
          ? [
              {
                type: "paragraph",
                paragraph: {
                  rich_text: [{ text: { content: "Ask for a referral" } }],
                },
              },
            ]
          : [],
        has_more: false,
      });
    if (String(url).includes("/query"))
      return Response.json({ results: [notionPage()], has_more: false });
    if (init?.method === "PATCH") {
      if (state.syncFails) return new Response("failure", { status: 503 });
      const data = JSON.parse(String(init.body));
      if (data.properties?.Stage)
        state.stage = data.properties.Stage.status.name;
      return Response.json({ id: "page" });
    }
    return Response.json(notionPage());
  };
  function notionPage() {
    return {
      id: "page",
      parent: { data_source_id: "data-source" },
      archived: state.archived,
      properties: {
        Company: { title: [{ text: { content: "Test" } }] },
        Position: {
          rich_text: [{ text: { content: j.title, link: { url: j.url } } }],
        },
        Link: { url: j.url },
        Source: { rich_text: [] },
        Stage: { status: { name: state.stage } },
        "Automation Status": { select: { name: "Review" } },
      },
    };
  }
  t.after(() => {
    globalThis.fetch = original;
    e.db.close();
  });
  const run = (name: string, args: any = {}) =>
    runAgentTool(e.env, name, args, "https://tracker.example.com");
  async function approved(requestId = "request", extra: any = {}) {
    const b = await run("prepare_batch", {
      requestId,
      jobIds: [j.id],
      ...extra,
    });
    await run("approve_batch", {
      batchId: b.batchId,
      fingerprint: b.fingerprint,
      userApproval: "Apply to this specific reviewed job",
    });
    return b;
  }
  return { ...e, p, j, state, run, approved };
}

test("connector token is scoped, validates origins/arguments, and supports MCP discovery", async (t) => {
  const f = await fixture(t);
  f.env.MUSE_TOKEN = "m".repeat(40);
  f.env.ADMIN_TOKEN = "a".repeat(40);
  const req = (
    path: string,
    body: any,
    token = f.env.MUSE_TOKEN,
    extra: Record<string, string> = {},
  ) =>
    new Request(`https://tracker.example.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await connectorFetch(
        req("/agent/tools/connection_status", {}, f.env.ADMIN_TOKEN),
        f.env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await connectorFetch(
        req("/agent/tools/connection_status", {}, f.env.MUSE_TOKEN, {
          origin: "https://evil.example",
        }),
        f.env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await connectorFetch(
        req("/agent/tools/prepare_batch", { requestId: "x", jobIds: [] }),
        f.env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await connectorFetch(
        req("/agent/tools/connection_status", { profile: "unexpected" }),
        f.env,
      )
    ).status,
    400,
  );
  const initialized = (await (
    await connectorFetch(
      req("/agent/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      f.env,
    )
  ).json()) as any;
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const listed = (await (
    await connectorFetch(
      req("/agent/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
      f.env,
    )
  ).json()) as any;
  assert.ok(
    listed.result.tools.some((tool: any) => tool.name === "prepare_batch"),
  );
  const bad = (await (
    await connectorFetch(
      req("/agent/mcp", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "prepare_batch", arguments: {} },
      }),
      f.env,
    )
  ).json()) as any;
  assert.equal(bad.result.isError, true);
  assert.equal(
    (await connectorFetch(req("/agent/tools/not_an_admin", {}), f.env)).status,
    404,
  );
});

test("batch retries are idempotent and approvals bind posting, profile, resume, and writing", async (t) => {
  const f = await fixture(t);
  const args = {
    requestId: "same",
    jobIds: [f.j.id],
    writtenAnswers: {
      [f.j.id]: {
        "Why this company?":
          "I want to apply my Python and SQL research skills.",
      },
    },
  };
  const b = await f.run("prepare_batch", args);
  assert.equal((await f.run("prepare_batch", args)).batchId, b.batchId);
  await assert.rejects(
    f.run("prepare_batch", { ...args, writtenAnswers: {} }),
    /different batch contents/,
  );
  assert.equal(
    b.items[0].writtenAnswers["Why this company?"],
    args.writtenAnswers[f.j.id]["Why this company?"],
  );
  await assert.rejects(
    f.run("approve_batch", {
      batchId: b.batchId,
      fingerprint: "wrong",
      userApproval: "approved",
    }),
    /fingerprint/,
  );
  await f.run("approve_batch", {
    batchId: b.batchId,
    fingerprint: b.fingerprint,
    userApproval: "I approve this batch and writing",
  });
  f.db
    .prepare("UPDATE jobs SET data=? WHERE id=?")
    .run(
      JSON.stringify({ ...f.j, description: f.j.description + " Changed." }),
      f.j.id,
    );
  await assert.rejects(
    f.run("reserve_application", {
      batchId: b.batchId,
      jobId: f.j.id,
      mode: "preview",
    }),
    /changed/,
  );
  f.db
    .prepare("UPDATE jobs SET data=? WHERE id=?")
    .run(JSON.stringify(f.j), f.j.id);
  f.db
    .prepare("UPDATE private_data SET data=? WHERE key='resume'")
    .run(btoa("changed resume"));
  await assert.rejects(
    f.run("get_materials", { batchId: b.batchId }),
    /changed/,
  );
});

test("verified facts and Spring availability are separate; unanswered questions block approval", async (t) => {
  const f = await fixture(t);
  assert.equal(profileForTrack(f.p, "full-time").earliestStart, "2027-06-01");
  assert.equal(
    profileForTrack(f.p, "spring-flex").answers.earliestStart.verified,
    false,
  );
  f.p.availability = {
    "spring-flex": {
      earliestStart: { value: "2027-01-15", verified: true },
      weeklyHours: { value: "10–20", verified: true },
    },
  };
  assert.equal(profileForTrack(f.p, "spring-flex").earliestStart, "2027-01-15");
  const b = await f.run("prepare_batch", {
    requestId: "questions",
    jobIds: [f.j.id],
    unresolvedQuestions: { [f.j.id]: ["Confirm production experience"] },
  });
  await assert.rejects(
    f.run("approve_batch", {
      batchId: b.batchId,
      fingerprint: b.fingerprint,
      userApproval: "Apply",
    }),
    /questions/,
  );
  f.p.answers.sponsorship = { value: "No", verified: false };
  f.p.answers.professionalYears = { value: "1", verified: false };
  f.db
    .prepare("UPDATE private_data SET data=? WHERE key='profile'")
    .run(JSON.stringify(f.p));
  const c = await f.run("prepare_batch", {
    requestId: "unverified",
    jobIds: [f.j.id],
  });
  assert.ok(
    c.items[0].unresolved.some((x: string) => x.includes("sponsorship")),
  );
  assert.equal(c.items[0].answers.sponsorship, undefined);
  assert.ok(
    c.items[0].unresolved.some((x: string) => x.includes("1-year minimum")),
  );
});

test("Muse and backup contend on one atomic reservation; previews release only before submit", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  const request = { batchId: b.batchId, jobId: f.j.id, mode: "preview" };
  const reserved = await f.run("reserve_application", request);
  assert.equal(await claimApplication(f.env, f.j, "backup", b.batchId), null);
  await assert.rejects(f.run("reserve_application", request), /reserved/);
  await assert.rejects(
    f.run("authorize_submission", {
      attemptId: reserved.attemptId,
      fields: [],
    }),
    /cannot be submitted/,
  );
  await f.run("record_result", {
    attemptId: reserved.attemptId,
    outcome: "preview",
    detail: "Uploaded approved resume; did not click submit",
  });
  await f.run("record_result", {
    attemptId: reserved.attemptId,
    outcome: "preview",
    detail: "Repeated recording",
  });
  assert.ok(await claimApplication(f.env, f.j, "backup", b.batchId));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 2);
});

test("launch gates, unknown fields, and uncertain outcomes cannot cause a duplicate submission", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  const request = { batchId: b.batchId, jobId: f.j.id, mode: "submit" };
  await assert.rejects(f.run("reserve_application", request), /gate is closed/);
  await setSetting(f.env, "agent_submissions_enabled", "true");
  const a = await f.run("reserve_application", request);
  const fields = [
    { kind: "resume", key: "resume", value: f.p.resumeSha256, label: "Resume" },
  ];
  await assert.rejects(
    f.run("authorize_submission", {
      attemptId: a.attemptId,
      fields: [
        ...fields,
        {
          kind: "fact",
          key: "new_fact",
          value: "Yes",
          label: "New requirement",
        },
      ],
    }),
    /require a fresh/,
  );
  await f.run("authorize_submission", { attemptId: a.attemptId, fields });
  await assert.rejects(
    f.run("authorize_submission", { attemptId: a.attemptId, fields }),
    /cannot be submitted/,
  );
  await assert.rejects(
    f.run("record_result", {
      attemptId: a.attemptId,
      outcome: "blocked",
      detail: "Maybe submitted",
    }),
    /uncertain/,
  );
  await f.run("record_result", {
    attemptId: a.attemptId,
    outcome: "uncertain",
    detail: "Lost confirmation after submit",
  });
  assert.equal(await claimApplication(f.env, f.j, "backup", b.batchId), null);
  await assert.rejects(f.run("reserve_application", request), /reserved/);
});

test("confirmation and delayed Notion sync are persisted without a second application", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  await setSetting(f.env, "agent_submissions_enabled", "true");
  const a = await f.run("reserve_application", {
    batchId: b.batchId,
    jobId: f.j.id,
    mode: "submit",
  });
  await f.run("authorize_submission", {
    attemptId: a.attemptId,
    fields: [
      {
        kind: "resume",
        key: "resume",
        value: f.p.resumeSha256,
        label: "Resume",
      },
    ],
  });
  const result = {
    attemptId: a.attemptId,
    outcome: "confirmed",
    detail: "Observed employer confirmation",
    confirmation: { url: f.j.applyUrl, text: "Thank you for applying" },
  };
  await assert.rejects(
    f.run("record_result", {
      ...result,
      confirmation: {
        ...result.confirmation,
        url: "https://evil.example/jobs/1",
      },
    }),
    /approved employer/,
  );
  f.state.syncFails = true;
  assert.equal((await f.run("record_result", result)).notionSyncPending, true);
  assert.equal(
    f.db.prepare("SELECT state FROM attempts WHERE id=?").get(a.attemptId)!
      .state,
    "confirmed",
  );
  f.state.syncFails = false;
  assert.equal(
    (await f.run("retry_notion_sync", { attemptId: a.attemptId }))
      .notionSyncPending,
    false,
  );
  assert.equal(f.state.stage, "Applied");
  const progress = await f.run("get_progress", { batchId: b.batchId });
  assert.equal(progress.batches[0].items[0].category, "Submitted");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 1);
});

test("live Notion changes, referral notes, closed jobs, and stale reviews stop a batch", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  const reserve = () =>
    f.run("reserve_application", {
      batchId: b.batchId,
      jobId: f.j.id,
      mode: "preview",
    });
  f.state.stage = "Rejected";
  await assert.rejects(reserve(), /status changed/);
  f.state.stage = "To apply";
  f.state.referral = true;
  await assert.rejects(reserve(), /Referral/);
  f.state.referral = false;
  f.db.prepare("UPDATE jobs SET open=0").run();
  await assert.rejects(reserve(), /closed/);
  f.db.prepare("UPDATE jobs SET open=1").run();
  f.db.prepare("UPDATE agent_postings SET reviewed_at='2026-01-01'").run();
  await assert.rejects(reserve(), /Reopen/);
});

test("crashed Muse attempts become uncertain and launch requires observed tests plus confirmed pilot", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  await assert.rejects(
    configureAgent(f.env, { action: "launch", tracks: ["full-time"] }),
    /tests first/,
  );
  await configureAgent(f.env, {
    action: "record-test",
    test: "connection",
    evidence: "Observed Muse call",
  });
  await configureAgent(f.env, {
    action: "record-test",
    test: "upload",
    evidence: "Observed private resume upload without submission",
  });
  await assert.rejects(
    configureAgent(f.env, { action: "launch", tracks: ["full-time"] }),
    /pilot/,
  );
  await configureAgent(f.env, {
    action: "enable-pilot",
    batchId: b.batchId,
    jobId: f.j.id,
    tracks: ["full-time"],
  });
  const a = await f.run("reserve_application", {
    batchId: b.batchId,
    jobId: f.j.id,
    mode: "submit",
  });
  f.db.prepare("UPDATE attempts SET started_at='2026-01-01'").run();
  const p = await f.run("get_progress", { batchId: b.batchId });
  assert.equal(p.batches[0].items[0].state, "uncertain");
  assert.equal(await claimApplication(f.env, f.j, "backup", b.batchId), null);
  await configureAgent(f.env, {
    action: "reconcile-not-submitted",
    attemptId: a.attemptId,
    evidence: "Owner verified no application in employer portal",
  });
  assert.ok(await claimApplication(f.env, f.j, "backup", b.batchId));
});

test("scheduled work never picks applications even if the old switch is enabled", async (t) => {
  const f = await fixture(t);
  await setSetting(f.env, "apply_enabled", "true");
  await scheduled(f.env, "*/15 * * * *");
  assert.ok(f.queued.every((task) => task.type !== "apply"));
});

test("email leads keep provenance and preserve existing applied records without duplicates", async (t) => {
  const f = await fixture(t);
  f.state.stage = "Applied";
  const args = {
    track: "full-time",
    job: f.j,
    evidence: ["1 year of experience"],
    observedAt: new Date().toISOString(),
    provenance: {
      kind: "email",
      emailId: "school-message-123",
      mailbox: "school",
      excerpt: "Relevant employer application link",
    },
  };
  const first = await f.run("add_lead", args);
  const second = await f.run("add_lead", args);
  assert.equal(first.jobId, second.jobId);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 1);
  assert.equal(f.state.stage, "Applied");
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare("SELECT provenance FROM agent_postings").get()!.provenance,
      ),
    ).emailId,
    "school-message-123",
  );
  await assert.rejects(
    f.run("add_lead", { ...args, evidence: ["Invented qualification"] }),
    /literal excerpts/,
  );
  await assert.rejects(
    f.run("add_lead", {
      ...args,
      job: { ...f.j, url: "http://localhost/private" },
    }),
    /public HTTPS/,
  );
});

test("ATS lead ingestion uses the employer API rather than a claimed early-career description", async (t) => {
  const f = await fixture(t),
    notionFetch = globalThis.fetch;
  const claimed = {
    ...f.j,
    company: "Other",
    url: "https://jobs.ashbyhq.com/other/456",
    applyUrl: "https://jobs.ashbyhq.com/other/456/application",
  };
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("api.ashbyhq.com"))
      return Response.json({
        jobs: [
          {
            id: "456",
            title: "Senior Data Scientist",
            jobUrl: claimed.url,
            applyUrl: claimed.applyUrl,
            descriptionPlain: "Python SQL. 5+ years of experience required.",
            location: "San Francisco",
            employmentType: "FullTime",
          },
        ],
      });
    return notionFetch(input, init);
  };
  const result = await f.run("add_lead", {
    track: "full-time",
    job: claimed,
    evidence: ["Python SQL"],
    observedAt: new Date().toISOString(),
    provenance: { kind: "search" },
  });
  assert.equal(result.fit.label, "Skip");
  assert.equal(
    result.verificationSource,
    "Employer ATS API independently fetched",
  );
  assert.equal(
    JSON.parse(
      String(
        f.db.prepare("SELECT data FROM jobs WHERE id='ashby:other:456'").get()!
          .data,
      ),
    ).title,
    "Senior Data Scientist",
  );
});

test("private resume downloads require scoped auth and failed or changed materials are rejected", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  f.env.MUSE_TOKEN = "m".repeat(40);
  const request = (authorized = true) =>
    new Request(
      `https://tracker.example.com/agent/resume?batchId=${b.batchId}`,
      {
        headers: authorized
          ? { Authorization: `Bearer ${f.env.MUSE_TOKEN}` }
          : {},
      },
    );
  assert.equal((await connectorFetch(request(false), f.env)).status, 401);
  const downloaded = await connectorFetch(request(), f.env);
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.equal(downloaded.headers.get("content-type"), "application/pdf");
  assert.equal(await downloaded.text(), "resume");
  f.db
    .prepare("UPDATE private_data SET data=? WHERE key='resume'")
    .run(btoa("different file"));
  assert.equal((await connectorFetch(request(), f.env)).status, 409);
});

test("confirmed Muse pilot enables launch and disables digest while preserving discovery", async (t) => {
  const f = await fixture(t),
    b = await f.approved();
  await setSetting(f.env, "email_enabled", "true");
  await setSetting(f.env, "sync_enabled", "true");
  await configureAgent(f.env, {
    action: "record-test",
    test: "connection",
    evidence: "Actual connection test fixture",
  });
  await configureAgent(f.env, {
    action: "record-test",
    test: "upload",
    evidence: "Actual fill-only fixture",
  });
  await configureAgent(f.env, {
    action: "enable-pilot",
    batchId: b.batchId,
    jobId: f.j.id,
    tracks: ["full-time"],
  });
  const a = await f.run("reserve_application", {
    batchId: b.batchId,
    jobId: f.j.id,
    mode: "submit",
  });
  await f.run("authorize_submission", {
    attemptId: a.attemptId,
    fields: [
      {
        kind: "resume",
        key: "resume",
        value: f.p.resumeSha256,
        label: "Resume",
      },
    ],
  });
  await f.run("record_result", {
    attemptId: a.attemptId,
    outcome: "confirmed",
    detail: "Employer receipt",
    confirmation: {
      text: "Your application has been submitted",
      url: f.j.applyUrl,
    },
  });
  await configureAgent(f.env, { action: "launch", tracks: ["full-time"] });
  assert.equal(
    f.db.prepare("SELECT value FROM settings WHERE key='email_enabled'").get()!
      .value,
    "false",
  );
  assert.equal(
    f.db.prepare("SELECT value FROM settings WHERE key='sync_enabled'").get()!
      .value,
    "true",
  );
});
