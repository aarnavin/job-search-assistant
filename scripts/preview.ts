import { mkdir, readFile, writeFile } from "node:fs/promises";
import sources from "../src/company-sources.json";
import { fetchJobs } from "../src/sources";
import { rank } from "../src/matching";
import { companyKey, identities, linksIn, plainTitle } from "../src/identity";
import type { Source } from "../src/types";
const snapshot = JSON.parse(
  await readFile(
    new URL("../private/notion-import.json", import.meta.url),
    "utf8",
  ).catch(() => '{"results":[]}'),
);
const known = snapshot.results.map((r: any) => ({
  company: r.Company,
  title: plainTitle(r.Position),
  ids: identities([r.Link, ...linksIn(r.Position)]),
  stage: r.Stage,
}));
const report: { createdAt: string; sources: any[]; matches: any[] } = {
  createdAt: new Date().toISOString(),
  sources: [],
  matches: [],
};
for (const source of sources as Source[]) {
  if (source.ats === "manual") {
    report.sources.push({ ...source, status: "manual" });
    continue;
  }
  try {
    const jobs = await fetchJobs(source);
    report.sources.push({ ...source, status: "ok", jobs: jobs.length });
    for (const job of jobs) {
      const fit = rank(job);
      if (fit.label === "Skip") continue;
      const ids = identities([job.url, job.applyUrl]);
      const exact = known.find((r: any) =>
        r.ids.some((i: string) => ids.includes(i)),
      );
      const possible = known.find(
        (r: any) =>
          companyKey(r.company) === companyKey(job.company) &&
          r.title === plainTitle(job.title),
      );
      report.matches.push({
        job,
        fit,
        existing: exact?.stage ?? possible?.stage ?? null,
        duplicateConfidence: exact ? "exact" : possible ? "title-review" : null,
        referral: source.referral,
        baseline: true,
      });
    }
    console.log(`${source.company}: ${jobs.length} postings checked`);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Feed failed";
    report.sources.push({ ...source, status: "error", error: message });
    console.log(`${source.company}: ${message}`);
  }
}
report.matches.sort((a, b) => b.fit.priority - a.fit.priority);
await mkdir("reports", { recursive: true });
await writeFile(
  "reports/discovery-preview.json",
  JSON.stringify(report, null, 2),
);
const lines = [
  "# Discovery preview",
  `Generated ${report.createdAt}. All results are baseline openings, not newly posted alerts.`,
  "",
  ...report.matches.map(
    (m) =>
      `- **${m.fit.label}** — ${m.job.company}: [${m.job.title}](${m.job.url}) · ${m.job.location} · ${m.existing ? "Already tracked (" + m.existing + ")" : "Not yet tracked"}${m.referral ? " · Referral hold" : ""}\n  ${m.fit.reasons.join("; ")}`,
  ),
  "",
  "## Coverage",
  ...report.sources.map(
    (s) =>
      `- ${s.company}: ${s.status}${s.jobs !== undefined ? " (" + s.jobs + " jobs)" : ""}${s.error ? " — " + s.error : ""}`,
  ),
];
await writeFile("reports/discovery-preview.md", lines.join("\n"));
console.log(
  JSON.stringify(
    {
      sources: report.sources.length,
      automated: report.sources.filter((s) => s.status === "ok").length,
      failed: report.sources.filter((s) => s.status === "error").length,
      matches: report.matches.length,
      newStrong: report.matches.filter(
        (m) => m.fit.label === "Strong" && !m.existing,
      ).length,
    },
    null,
    2,
  ),
);
