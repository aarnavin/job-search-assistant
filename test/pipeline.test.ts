import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, syncJob } from "../src/pipeline";
import { importPages, referralHold, setSetting, lock } from "../src/store";
import { digestContent, sendDigest } from "../src/digest";
import { environment, job } from "./helpers";
const source = { id: "test", company: "Test", ats: "ashby", board: "test" };
const feed = (ids: string[]) => ({
  jobs: ids.map((id) => ({
    id,
    title: "Data Scientist, New Grad 2027",
    jobUrl: `https://jobs.ashbyhq.com/test/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/test/${id}/application`,
    location: "San Francisco",
    descriptionPlain: "Python SQL causal inference",
    employmentType: "FullTime",
  })),
});
async function setup() {
  const e = environment();
  await setSetting(e.env, "paused", "false");
  e.db
    .prepare("INSERT INTO sources(id,data) VALUES(?,?)")
    .run("test", JSON.stringify(source));
  return e;
}
test("baseline, repeat scan, later new opening, and failed scans preserve correct state", async () => {
  const { env, db } = await setup();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(feed(["one"]));
    await scan(env, "test");
    await scan(env, "test");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 1);
    assert.equal(db.prepare("SELECT baseline FROM jobs").get()!.baseline, 1);
    globalThis.fetch = async () => Response.json(feed(["one", "two"]));
    await scan(env, "test");
    assert.equal(
      db.prepare("SELECT baseline FROM jobs WHERE id='ashby:test:two'").get()!
        .baseline,
      0,
    );
    globalThis.fetch = async () => new Response("error", { status: 503 });
    await assert.rejects(scan(env, "test"));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE open=1").get()!.n,
      2,
    );
    assert.match(
      String(db.prepare("SELECT last_error FROM sources").get()!.last_error),
      /503/,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    globalThis.fetch = async () => Response.json(feed(["two"]));
    await scan(env, "test");
    assert.equal(
      db.prepare("SELECT open FROM jobs WHERE id='ashby:test:one'").get()!.open,
      0,
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("existing application and referral metadata are preserved without writes", async () => {
  const { env, db } = await setup();
  const original = globalThis.fetch;
  try {
    await setSetting(env, "sync_enabled", "true");
    await importPages(env, [
      {
        id: "existing",
        company: "Test",
        title: "Data Scientist 2027",
        stage: "Interview",
        source: "Referral",
        links: ["https://jobs.ashbyhq.com/test/one"],
        referral: true,
      },
    ]);
    globalThis.fetch = async () => Response.json(feed(["one"]));
    await scan(env, "test");
    let writes = 0;
    globalThis.fetch = async () => {
      writes++;
      throw new Error("No Notion writes expected");
    };
    await syncJob(env, "ashby:test:one");
    assert.equal(writes, 0);
    assert.equal(
      db.prepare("SELECT notion_id FROM jobs").get()!.notion_id,
      "existing",
    );
    assert.equal(
      db.prepare("SELECT stage FROM existing_pages").get()!.stage,
      "Interview",
    );
    assert.equal(await referralHold(env, "TEST"), true);
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("Notion create timeout holds retry rather than making a duplicate", async () => {
  const { env, db } = await setup();
  const original = globalThis.fetch;
  try {
    await setSetting(env, "sync_enabled", "true");
    await importPages(env, []);
    globalThis.fetch = async () => Response.json(feed(["one"]));
    await scan(env, "test");
    let creates = 0;
    globalThis.fetch = async () => {
      creates++;
      throw new Error("Lost response after creation");
    };
    await assert.rejects(syncJob(env, "ashby:test:one"));
    await syncJob(env, "ashby:test:one");
    assert.equal(creates, 1);
    assert.equal(
      db.prepare("SELECT state FROM sync_writes").get()!.state,
      "uncertain",
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("global pause stops scanning and locking excludes simultaneous operations", async () => {
  const { env, db } = await setup();
  await setSetting(env, "paused", "true");
  await scan(env, "test");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n, 0);
  assert.ok(await lock(env, "browser"));
  assert.equal(await lock(env, "browser"), null);
  db.close();
});
test("daily digest retries explicit rate limits but not uncertain delivery", async () => {
  const { env, db } = await setup();
  Object.assign(env, {
    BREVO_API_KEY: "test",
    BREVO_SENDER: "test@example.com",
  });
  await setSetting(env, "email_enabled", "true");
  const original = globalThis.fetch;
  const now = new Date("2027-07-01T15:00:00Z");
  let sends = 0;
  try {
    globalThis.fetch = async () => {
      sends++;
      return new Response("", { status: 429 });
    };
    await assert.rejects(sendDigest(env, now));
    globalThis.fetch = async () => {
      sends++;
      return Response.json({ messageId: "123" });
    };
    await sendDigest(env, now);
    await sendDigest(env, now);
    assert.equal(sends, 2);
    globalThis.fetch = async () => {
      sends++;
      throw new Error("Connection lost");
    };
    await assert.rejects(sendDigest(env, new Date("2027-07-02T15:00:00Z")));
    await sendDigest(env, new Date("2027-07-02T15:05:00Z"));
    assert.equal(sends, 3);
    assert.equal(
      db.prepare("SELECT state FROM digest WHERE local_day='2027-07-02'").get()!
        .state,
      "uncertain",
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("digest excludes unverified roles, software roles, and prior applications even with stale fit labels", async () => {
  const { env, db } = await setup();
  const valid = job();
  const unknown = job({
    id: "ashby:test:unknown",
    title: "Data Scientist 2027",
    url: "https://jobs.ashbyhq.com/test/unknown",
    applyUrl: "https://jobs.ashbyhq.com/test/unknown/application",
    description: "Python SQL.",
  });
  const software = job({
    id: "ashby:test:software",
    title: "Software Engineer, New Grad",
    url: "https://jobs.ashbyhq.com/test/software",
    applyUrl: "https://jobs.ashbyhq.com/test/software/application",
  });
  for (const j of [valid, unknown, software])
    db.prepare(
      "INSERT INTO jobs(id,source_id,data,fit,reasons,first_seen,last_seen,baseline,open) VALUES(?,?,?,?,?,?,?,?,1)",
    ).run(
      j.id,
      "test",
      JSON.stringify(j),
      "Strong",
      "[]",
      "2027-07-01T00:00:00Z",
      "2027-07-01T00:00:00Z",
      0,
    );
  const since = "2027-06-30T00:00:00Z";
  const before = await digestContent(env, since);
  assert.match(before, /New matches \(1\)/);
  assert.doesNotMatch(before, /Action needed/);
  assert.doesNotMatch(before, /Coverage and failures|Service notices/);
  assert.doesNotMatch(before, /Data Scientist 2027<\/a>/);
  assert.doesNotMatch(before, /Software Engineer, New Grad/);
  await importPages(env, [
    {
      id: "applied",
      company: valid.company,
      title: valid.title,
      stage: "Applied",
      source: "LinkedIn",
      links: [valid.url],
      referral: false,
    },
  ]);
  const after = await digestContent(env, since);
  assert.doesNotMatch(after, /New matches/);
  db.close();
});
test("digest shows a short alert only for failed automated feeds", async () => {
  const { env, db } = await setup();
  db.prepare("UPDATE sources SET last_error='HTTP 503' WHERE id='test'").run();
  db.prepare("INSERT INTO sources(id,data,last_error) VALUES(?,?,?)").run(
    "manual",
    JSON.stringify({
      id: "manual",
      company: "Manual Company",
      ats: "manual",
      careerUrl: "https://example.com/careers",
    }),
    "Manual career-site check required",
  );
  const content = await digestContent(env, "2027-06-30T00:00:00Z");
  assert.match(content, /Tracker alert/);
  assert.match(content, /Couldn’t check Test today/);
  assert.doesNotMatch(content, /HTTP 503|Manual Company|Service notices/);
  db.close();
});
