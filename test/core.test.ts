import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identities,
  jobIdentity,
  linksIn,
  normalizeUrl,
} from "../src/identity";
import { rank } from "../src/matching";
import { parseJobs, fetchJobs } from "../src/sources";
import { planFields, profileProblems } from "../src/forms";
import { localClock, escapeHtml } from "../src/digest";
import { job, profile } from "./helpers";
test("identity matches ATS links across tracking parameters and application suffixes", () => {
  assert.equal(
    jobIdentity(
      "https://jobs.ashbyhq.com/Solace/abc/application?utm_source=campus",
    ),
    "ashby:solace:abc",
  );
  assert.equal(
    jobIdentity(
      "https://job-boards.greenhouse.io/twitch/jobs/123?gh_src=linkedin",
    ),
    "greenhouse:twitch:123",
  );
  assert.equal(
    normalizeUrl("https://jobs.bytedance.com/en/position/application"),
    null,
  );
  assert.equal(normalizeUrl("https://example.com/my-profile"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.deepEqual(
    identities(
      linksIn("[Data Scientist](https://jobs.ashbyhq.com/Solace/abc)"),
    ),
    ["ashby:solace:abc"],
  );
});
test("matches target roles but flags geography, seniority, internships and incompatible availability", () => {
  assert.equal(rank(job()).label, "Strong");
  assert.equal(rank(job({ location: "New York" })).label, "Possible");
  for (const title of [
    "Senior Data Scientist",
    "Staff Machine Learning Engineer",
    "ML Intern",
  ])
    assert.equal(rank(job({ title })).label, "Skip");
  assert.equal(
    rank(job({ description: "Python SQL. 3 years of experience required." }))
      .label,
    "Possible",
  );
  assert.equal(
    rank(job({ description: "Python SQL. 5 years of experience required." }))
      .label,
    "Skip",
  );
  assert.equal(
    rank(job({ description: "Python SQL. PhD required." })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ description: "Python SQL. Start immediately." })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ description: "Python SQL. Start date: 2027-02-01" })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ description: "Python SQL. Start in January 2027" })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ description: "Python SQL. Start date negotiable." })).label,
    "Strong",
  );
  assert.equal(rank(job({ title: "Recruiter, AI/ML Research" })).label, "Skip");
  assert.equal(
    rank(job({ description: "We leverage machine learning." })).label,
    "Possible",
  );
  assert.equal(
    rank(
      job({ title: "Machine Learning Engineer", description: "Python SQL." }),
    ).label,
    "Possible",
  );
});
test("adapters reject malformed responses and do not invent posting dates", () => {
  const source = {
    id: "test",
    company: "Test",
    ats: "greenhouse" as const,
    board: "test",
  };
  const [j] = parseJobs(source, {
    jobs: [
      {
        id: 123,
        title: "Data Scientist",
        absolute_url: "https://boards.greenhouse.io/test/jobs/123",
        location: { name: "SF" },
        content: "<p>Python &amp; SQL</p>",
        updated_at: "2026-01-01",
      },
    ],
  });
  assert.equal(j.description, "Python & SQL");
  assert.equal(j.postedAt, null);
  assert.throws(() => parseJobs(source, { error: "no access" }));
});
test("Lever follows pagination rather than truncating a 100-job board", async () => {
  let calls = 0;
  const source = {
    id: "test",
    company: "Test",
    ats: "lever" as const,
    board: "test",
  };
  const response = async () => {
    calls++;
    return Response.json(
      Array.from({ length: calls === 1 ? 100 : 1 }, (_, i) => ({
        id: `${calls}-${i}`,
        text: "Data Scientist",
        hostedUrl: `https://jobs.lever.co/test/${calls}-${i}`,
      })),
    );
  };
  const jobs = await fetchJobs(source, response as typeof fetch);
  assert.equal(jobs.length, 101);
  assert.equal(calls, 2);
});
test("forms use verified answers only and fail on unknown required fields and essays", () => {
  const p = profile();
  const result = planFields(
    [
      { index: 0, label: "Name *", type: "text", required: true },
      { index: 1, label: "Resume", type: "file", required: true },
      { index: 2, label: "Favorite color", type: "text", required: false },
    ],
    p,
  );
  assert.equal(result.blockers.length, 0);
  assert.equal(result.fills.length, 2);
  assert.ok(
    planFields(
      [
        {
          index: 0,
          label: "Are you a US citizen?",
          type: "select",
          required: true,
          options: ["Yes", "No"],
        },
      ],
      p,
    ).blockers.length,
  );
  assert.ok(
    planFields(
      [
        {
          index: 0,
          label: "Why this company?",
          type: "textarea",
          required: false,
        },
      ],
      p,
    ).blockers.length,
  );
  assert.ok(
    planFields(
      [
        {
          index: 0,
          label: "I agree to the terms",
          type: "checkbox",
          required: true,
        },
      ],
      p,
    ).blockers.length,
  );
  assert.equal(profileProblems(p).length, 0);
  p.answers.authorizedUS.verified = false;
  assert.ok(profileProblems(p).includes("Verify authorizedUS"));
});
test("digest follows Pacific daylight saving time and escapes employer HTML", () => {
  assert.deepEqual(localClock(new Date("2027-01-01T16:00:00Z")), {
    day: "2027-01-01",
    hour: 8,
  });
  assert.deepEqual(localClock(new Date("2027-07-01T15:00:00Z")), {
    day: "2027-07-01",
    hour: 8,
  });
  assert.equal(localClock(new Date("2027-07-01T01:00:00Z")).day, "2027-06-30");
  assert.equal(escapeHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");
});
