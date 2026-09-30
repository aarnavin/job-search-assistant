import type { Job, Source } from "./types";
export function stripHtml(s: string): string {
  return s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
export function sourceUrl(s: Source): string {
  if (!s.board || !/^[a-z0-9_-]+$/i.test(s.board))
    throw new Error("Invalid board identifier");
  if (s.ats === "ashby")
    return `https://api.ashbyhq.com/posting-api/job-board/${s.board}`;
  if (s.ats === "greenhouse")
    return `https://boards-api.greenhouse.io/v1/boards/${s.board}/jobs?content=true`;
  if (s.ats === "lever")
    return `https://api.lever.co/v0/postings/${s.board}?mode=json&limit=100&skip=0`;
  throw new Error("Manual career site");
}
function date(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string | number);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}
export function parseJobs(s: Source, payload: any): Job[] {
  const list = s.ats === "lever" ? payload : payload?.jobs;
  if (!Array.isArray(list))
    throw new Error("Invalid job feed: expected jobs array");
  return list.map((j: any) => {
    const id = String(j.id ?? "");
    const title = j.title ?? j.text;
    const url = j.jobUrl ?? j.absolute_url ?? j.hostedUrl;
    if (!id || typeof title !== "string" || typeof url !== "string")
      throw new Error("Malformed job in feed");
    const description =
      j.descriptionPlain ??
      j.descriptionPlainText ??
      j.content ??
      j.description ??
      "";
    return {
      id: `${s.ats}:${s.board!.toLowerCase()}:${id}`,
      sourceId: s.id,
      company: s.company,
      ats: s.ats,
      title,
      url,
      applyUrl: j.applyUrl ?? j.applicationUrl ?? url,
      location:
        typeof j.location === "string"
          ? j.location
          : [
              j.location?.name,
              j.categories?.location,
              ...(j.secondaryLocations ?? []).map((l: any) => l.location),
            ]
              .filter(Boolean)
              .join("; "),
      description: stripHtml(
        description +
          " " +
          (j.lists ?? []).map((l: any) => l.text + " " + l.content).join(" "),
      ),
      postedAt: date(j.publishedAt ?? j.createdAt ?? j.first_published),
      employmentType: j.employmentType ?? j.categories?.commitment ?? "",
      listed: j.isListed !== false,
    } as Job;
  });
}
// Bind through a wrapper. Cloudflare's native fetch requires the global receiver.
export async function fetchJobs(
  s: Source,
  request: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<Job[]> {
  let url = sourceUrl(s);
  const jobs: Job[] = [];
  for (let page = 0; page < 30; page++) {
    const r = await request(url, {
      signal: AbortSignal.timeout(25000),
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Career feed HTTP ${r.status}`);
    const parsed = parseJobs(s, await r.json());
    jobs.push(...parsed);
    if (s.ats !== "lever" || parsed.length < 100) return jobs;
    url = sourceUrl(s).replace("skip=0", `skip=${(page + 1) * 100}`);
  }
  throw new Error("Pagination exceeded supported feed size; scan incomplete");
}
