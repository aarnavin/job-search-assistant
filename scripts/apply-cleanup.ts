import { readFile, writeFile } from "node:fs/promises";

if (!process.env.WORKER_URL || !process.env.ADMIN_TOKEN)
  throw new Error("WORKER_URL and ADMIN_TOKEN must be set locally");
const base = new URL(process.env.WORKER_URL);
if (base.protocol !== "https:") throw new Error("HTTPS required");
const preview = JSON.parse(
  await readFile("reports/cleanup-preview.json", "utf8"),
) as {
  archive: { id: string; company: string; title: string }[];
};
const resultsPath = "reports/cleanup-results.json";
const previous = JSON.parse(
  await readFile(resultsPath, "utf8").catch(() => "{}"),
) as Record<string, { archived: boolean; reason?: string; error?: string }>;
const results = { ...previous };
let processed = 0;
for (const page of preview.archive) {
  if (results[page.id]?.archived) continue;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(new URL("/maintenance", base), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "archive-unverified",
          pageId: page.id,
          expectedTitle: page.title,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const result = (await response.json()) as {
        archived?: boolean;
        reason?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Archive failed");
      results[page.id] = {
        archived: result.archived === true,
        reason: result.reason,
      };
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      results[page.id] = { archived: false, error: message };
      if (attempt < 2) await new Promise((done) => setTimeout(done, 1500));
    }
  }
  await writeFile(resultsPath, JSON.stringify(results, null, 2) + "\n");
  processed++;
  if (processed % 10 === 0)
    console.log(
      "Checked " +
        processed +
        " pages; archived " +
        Object.values(results).filter((result) => result.archived).length,
    );
  await new Promise((done) => setTimeout(done, 700));
}
const summary = {
  requested: preview.archive.length,
  archived: Object.values(results).filter((result) => result.archived).length,
  skipped: Object.values(results).filter(
    (result) => !result.archived && !result.error,
  ).length,
  errors: Object.entries(results)
    .filter(([, result]) => result.error)
    .map(([id, result]) => ({ id, error: result.error })),
};
console.log(JSON.stringify(summary, null, 2));
if (summary.errors.length) process.exitCode = 1;
