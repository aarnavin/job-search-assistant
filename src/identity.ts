export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.protocol = "https:";
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const atsPosting =
      /^(?:jobs\.ashbyhq\.com|jobs\.lever\.co)$/.test(u.hostname) &&
      u.pathname.split("/").filter(Boolean).length >= 2;
    if (
      /(?:^|\/)(?:my-profile|userhome|applications?|login|sign-in)(?:\/|$)/i.test(
        u.pathname,
      ) &&
      !/\/jobs?\/[^/]+/i.test(u.pathname) &&
      !atsPosting
    )
      return null;
    for (const key of [...u.searchParams.keys()])
      if (!["jobId", "job_id", "gh_jid", "jk"].includes(key))
        u.searchParams.delete(key);
    u.pathname = u.pathname.replace(/\/$/, "");
    u.searchParams.sort();
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"\)]+/g)].map((m) => m[0]);
}
export function jobIdentity(raw: string): string | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const u = new URL(normalized);
  const p = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "jobs.ashbyhq.com" && p.length >= 2)
    return `ashby:${p[0].toLowerCase()}:${p[1].toLowerCase()}`;
  if (
    /^(?:job-boards|boards)\.greenhouse\.io$/.test(u.hostname) &&
    p[1] === "jobs" &&
    p[2]
  )
    return `greenhouse:${p[0].toLowerCase()}:${p[2]}`;
  if (u.hostname === "jobs.lever.co" && p.length >= 2)
    return `lever:${p[0].toLowerCase()}:${p[1]}`;
  return `url:${normalized}`;
}
export function identities(urls: string[]): string[] {
  return [...new Set(urls.map(jobIdentity).filter((v): v is string => !!v))];
}
export function plainTitle(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
export function companyKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}
