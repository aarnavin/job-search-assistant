import { mkdir, writeFile } from "node:fs/promises";
import sources from "../src/company-sources.example.json";
import { rank } from "../src/matching";
import { fetchJobs } from "../src/sources";
import type { Source } from "../src/types";

// Public example boards only. No Notion account, resume, or application data.
const results = await Promise.all(
  (sources as Source[]).map(async (source) => {
    const jobs = await fetchJobs(source);
    return jobs
      .filter((job) => job.listed)
      .map((job) => ({ job, fit: rank(job) }))
      .filter(({ fit }) => fit.bayArea && fit.label !== "Skip")
      .map(({ job, fit }) => ({
        id: job.id,
        company: job.company,
        title: job.title,
        location: job.location,
        url: job.url,
        fit: fit.label,
      }));
  }),
);

const jobs = results.flat().sort((a, b) => a.id.localeCompare(b.id));
await mkdir("data", { recursive: true });
await writeFile(
  "data/public-board-snapshot.json",
  JSON.stringify({ schemaVersion: 1, jobs }, null, 2) + "\n",
);
console.log(
  `Public snapshot: ${jobs.length} relevant openings from ${sources.length} boards`,
);
