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
import { assessListing } from "../src/maintenance";
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
    "Skip",
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
    "Skip",
  );
});
test("only employer-verified early-career roles in the chosen fields qualify", () => {
  assert.equal(
    rank(job({ title: "Data Scientist 2027", description: "Python SQL." }))
      .label,
    "Skip",
  );
  assert.equal(
    rank(
      job({
        title: "Data Scientist",
        description: "Python SQL. 2+ years of experience.",
      }),
    ).earlyCareerVerified,
    true,
  );
  assert.equal(
    rank(job({ title: "Data Scientist, New Grad", description: "" })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ title: "Software Engineer, New Grad" })).label,
    "Skip",
  );
  assert.equal(
    rank(job({ title: "Forward Deployed Engineer, New Grad" })).label,
    "Skip",
  );
  const bcg = rank(
    job({
      title: "Forward Deployed AI Scientist, Campus",
      description: "Early career role. Python SQL machine learning.",
    }),
  );
  assert.equal(bcg.label, "Strong");
  assert.equal(bcg.earlyCareerVerified, true);
  assert.equal(
    rank(job({ title: "Research Scientist, New Grad" })).label,
    "Strong",
  );
  assert.equal(
    rank(
      job({
        description:
          "Python SQL. 1 year experience. 4+ years in production systems.",
      }),
    ).label,
    "Skip",
  );
  assert.equal(
    rank(
      job({
        title: "Research Engineer - New Grad (2027)",
        description:
          "Early-career research. MSc or PhD in machine learning, graduating by December 2026 or Summer 2027. Python PyTorch. 1+ year of experience.",
      }),
    ).label,
    "Possible",
  );
  assert.equal(
    rank(
      job({
        title: "Master's University Grad Machine Learning Engineer 2027 (USA)",
        description:
          "Master's degree required. Python PyTorch machine learning.",
      }),
    ).earlyCareerVerified,
    true,
  );
  assert.equal(
    rank(job({ title: "PhD University Grad Machine Learning Engineer" })).label,
    "Skip",
  );
  assert.equal(
    rank(
      job({
        title: "Machine Learning Engineer II",
        description: "Python PyTorch. 2+ years of experience.",
      }),
    ).label,
    "Skip",
  );
  assert.equal(
    rank(
      job({
        title: "Data Scientist",
        description: "Python SQL. Preferred: 1 year of experience.",
      }),
    ).label,
    "Skip",
  );
  assert.equal(
    rank(
      job({
        title: "Data Scientist",
        description: "Python SQL. We launched 2 years ago.",
      }),
    ).label,
    "Skip",
  );
});
test("Notion cleanup preserves history and watchlists but removes unverified active listings", () => {
  const page = {
    id: "page",
    company: "Test",
    title: "Data Scientist, New Grad 2027",
    stage: "To apply",
    source: "company board",
    links: ["https://jobs.ashbyhq.com/test/123"],
    referral: false,
  };
  const tracked = [
    { id: job().id, data: JSON.stringify(job()), notion_id: "page", open: 1 },
  ];
  assert.equal(assessListing(page, tracked).action, "keep");
  assert.equal(
    assessListing({ ...page, stage: "Applied" }, []).action,
    "preserve",
  );
  assert.equal(assessListing({ ...page, title: "" }, []).action, "preserve");
  assert.equal(assessListing(page, []).action, "archive");
  assert.equal(
    assessListing({ ...page, source: "Contract lead · Handshake AI" }, [])
      .action,
    "preserve",
  );
  assert.equal(
    assessListing(page, [
      {
        ...tracked[0],
        data: JSON.stringify(job({ title: "Software Engineer, New Grad" })),
      },
    ]).action,
    "archive",
  );
  assert.equal(
    assessListing(page, [{ ...tracked[0], open: 0 }]).action,
    "archive",
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
  assert.equal(
    parseJobs(source, {
      jobs: [
        {
          id: 124,
          title: "Data Scientist, New Grad",
          absolute_url: "https://boards.greenhouse.io/test/jobs/124",
          content: "&lt;p&gt;Python &amp; SQL&lt;/p&gt;",
        },
      ],
    })[0].description,
    "Python & SQL",
  );
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
