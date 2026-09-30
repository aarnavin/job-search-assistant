import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyJob, jobFingerprint, safeApplyUrl } from "../src/applications";
import { importPages, setSetting } from "../src/store";
import { environment, job, profile } from "./helpers";
import worker from "../src/worker";
async function setup() {
  const e = environment();
  const j = job();
  const p = profile();
  p.approvedJobIds = [j.id];
  p.approvedJobHashes = { [j.id]: await jobFingerprint(j) };
  p.resumeSha256 = createHash("sha256").update("resume").digest("hex");
  await setSetting(e.env, "paused", "false");
  await setSetting(e.env, "apply_enabled", "true");
  e.db
    .prepare("INSERT INTO private_data VALUES(?,?)")
    .run("profile", JSON.stringify(p));
  e.db
    .prepare("INSERT INTO private_data VALUES(?,?)")
    .run("resume", btoa("resume"));
  e.db.prepare("INSERT INTO sources(id,data) VALUES(?,?)").run(
    "test",
    JSON.stringify({
      id: "test",
      company: "Test",
      ats: "ashby",
      board: "test",
    }),
  );
  e.db
    .prepare(
      "INSERT INTO jobs(id,source_id,data,fit,reasons,first_seen,last_seen,baseline,notion_id) VALUES(?,?,?,'Strong','[]',?,?,0,'page')",
    )
    .run(
      j.id,
      "test",
      JSON.stringify(j),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  await importPages(e.env, []);
  return { ...e, j };
}
function requestMock(j: ReturnType<typeof job>, stage = "To apply") {
  return (async (url: any, options: any) => {
    const u = String(url);
    if (u.includes("api.ashbyhq.com"))
      return Response.json({
        jobs: [
          {
            id: "123",
            title: j.title,
            jobUrl: j.url,
            applyUrl: j.applyUrl,
            location: j.location,
            descriptionPlain: j.description,
            employmentType: j.employmentType,
          },
        ],
      });
    if (u.includes("/children"))
      return Response.json({ results: [], has_more: false });
    if (options?.method === "PATCH") return Response.json({ id: "page" });
    return Response.json({
      id: "page",
      properties: {
        Company: { title: [{ text: { content: "Test" } }] },
        Position: { rich_text: [] },
        Source: { rich_text: [] },
        Stage: { status: { name: stage } },
        "Automation Status": { select: { name: "Ready" } },
      },
    });
  }) as typeof fetch;
}
function browserMock(confirmed = true) {
  let clicks = 0,
    closed = 0;
  const field = {
    waitFor: async () => {},
    setInputFiles: async () => {},
    fill: async () => {},
    selectOption: async () => {},
    check: async () => {},
    first() {
      return field;
    },
    nth() {
      return field;
    },
    count: async () => 0,
    evaluateAll: async () => [
      { index: 0, label: "Name", type: "text", required: true },
      { index: 1, label: "Email", type: "email", required: true },
      { index: 2, label: "Resume", type: "file", required: true },
    ],
  };
  const page = {
    goto: async () => {},
    url: () => job().applyUrl,
    setDefaultTimeout: () => {},
    locator: () => field,
    getByRole: (role: string) =>
      role === "button"
        ? {
            click: async () => {
              clicks++;
            },
          }
        : field,
    getByText: () => ({
      first: () => ({
        waitFor: async () => {
          if (!confirmed) throw new Error("No confirmation received");
        },
        innerText: async () => "Application submitted",
      }),
    }),
  };
  return {
    launch: (async () => ({
      newContext: async () => ({ newPage: async () => page }),
      close: async () => {
        closed++;
      },
    })) as any,
    get clicks() {
      return clicks;
    },
    get closed() {
      return closed;
    },
  };
}
test("application attempt is recorded, confirmed, and never duplicated", async () => {
  const { env, db, j } = await setup(),
    original = globalThis.fetch,
    browser = browserMock();
  try {
    globalThis.fetch = requestMock(j);
    await applyJob(env, j.id, false, browser.launch);
    assert.equal(browser.clicks, 1);
    assert.equal(
      db.prepare("SELECT state FROM attempts").get()!.state,
      "confirmed",
    );
    assert.equal(
      db.prepare("SELECT automation FROM jobs").get()!.automation,
      "Submitted",
    );
    await applyJob(env, j.id, false, browser.launch);
    assert.equal(browser.clicks, 1);
    assert.ok(browser.closed);
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("lost confirmation is uncertain and cannot cause an automatic resubmission", async () => {
  const { env, db, j } = await setup(),
    original = globalThis.fetch,
    browser = browserMock(false);
  try {
    globalThis.fetch = requestMock(j);
    await applyJob(env, j.id, false, browser.launch);
    await applyJob(env, j.id, false, browser.launch);
    assert.equal(browser.clicks, 1);
    assert.equal(
      db.prepare("SELECT state FROM attempts").get()!.state,
      "uncertain",
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("preview fills without submission, and crash reservations exhaust the daily budget", async () => {
  const { env, db, j } = await setup(),
    original = globalThis.fetch,
    browser = browserMock();
  try {
    globalThis.fetch = requestMock(j);
    await applyJob(env, j.id, true, browser.launch);
    assert.equal(browser.clicks, 0);
    assert.equal(
      db.prepare("SELECT state FROM attempts").get()!.state,
      "preview",
    );
    db.prepare("DELETE FROM attempts").run();
    for (let i = 0; i < 3; i++)
      db.prepare(
        "INSERT INTO attempts(id,job_id,state,started_at,reserved_seconds) VALUES(?,?,'preparing',?,180)",
      ).run(String(i), "other" + i, new Date().toISOString());
    await applyJob(env, j.id, false, browser.launch);
    assert.equal(browser.clicks, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 3);
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("user stage changes prevent submission, and arbitrary hosts are rejected", async () => {
  const { env, db, j } = await setup(),
    original = globalThis.fetch,
    browser = browserMock();
  try {
    globalThis.fetch = requestMock(j, "Interview");
    await applyJob(env, j.id, false, browser.launch);
    assert.equal(browser.clicks, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()!.n, 0);
    assert.equal(
      safeApplyUrl(job({ applyUrl: "https://evil.example/test/123" })),
      false,
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("admin routes require a long bearer secret; no profile means no enabling auto-apply", async () => {
  const { env, db } = environment();
  env.ADMIN_TOKEN = "x".repeat(40);
  const response = await worker.fetch(
    new Request("https://worker.test/status"),
    env,
  );
  assert.equal(response.status, 401);
  const denied = await worker.fetch(
    new Request("https://worker.test/settings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apply_enabled: true }),
    }),
    env,
  );
  assert.equal(denied.status, 409);
  db.close();
});
