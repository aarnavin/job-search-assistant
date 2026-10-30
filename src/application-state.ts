import type { Env, Job, Profile, SearchTrack } from "./types";
import { setting } from "./store";
import { profileProblems } from "./forms";
import { jobIdentity } from "./identity";

export async function fingerprint(value: unknown): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function jobFingerprint(job: Job) {
  return fingerprint([
    job.title,
    job.description,
    job.location,
    job.applyUrl,
    job.employmentType,
    job.listed,
  ]);
}
export function profileForTrack(profile: Profile, track: SearchTrack): Profile {
  const availability = profile.availability?.[track];
  if (!availability && track === "full-time") return profile;
  const earliest = availability?.earliestStart ?? {
    value: "",
    verified: false,
  };
  return {
    ...profile,
    earliestStart: earliest.value,
    answers: {
      ...profile.answers,
      earliestStart: earliest,
      ...(track === "spring-flex"
        ? {
            weeklyHours: availability?.weeklyHours ?? {
              value: "10–20",
              verified: false,
            },
          }
        : {}),
    },
  };
}
export function trackProfileProblems(profile: Profile, track: SearchTrack) {
  const p = profileForTrack(profile, track);
  const problems = profileProblems(p, track);
  return { profile: p, problems };
}
export async function privateMaterials(env: Env) {
  const records = await env.DB.prepare(
    "SELECT key,data FROM private_data WHERE key IN ('profile','resume')",
  ).all<{ key: string; data: string }>();
  const p = records.results.find((r) => r.key === "profile");
  const resume = records.results.find((r) => r.key === "resume")?.data;
  if (!p || !resume)
    throw new Error("Upload the application profile and private resume first");
  const profile: Profile = JSON.parse(p.data);
  const bytes = Uint8Array.from(atob(resume), (c) => c.charCodeAt(0));
  const resumeHash = await fingerprint(bytes);
  const version = await fingerprint({ profile, resumeHash });
  return { profile, resumeHash, version, bytes };
}
export type ApplicationAttempt = {
  id: string;
  job_id: string;
  state: string;
  runner: string;
  batch_id: string | null;
  started_at: string;
  finished_at: string | null;
  evidence: string | null;
  error: string | null;
};
export async function claimApplication(
  env: Env,
  job: Job,
  runner: "muse" | "backup",
  batchId?: string,
): Promise<string | null> {
  if ((await setting(env, "paused")) === "true") return null;
  const identity = jobIdentity(job.url);
  if (!identity) throw new Error("A specific posting identity is required");
  // The original runner's pre-migration attempts already use these canonical job IDs.
  if (
    await env.DB.prepare(
      "SELECT id FROM attempts WHERE job_id=? OR job_id=? OR identity=?",
    )
      .bind(job.id, identity, identity)
      .first()
  )
    return null;
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO attempts(id,job_id,state,started_at,reserved_seconds,runner,batch_id,identity) VALUES(?,?,'preparing',?,?,?,?,?)",
  )
    .bind(
      id,
      job.id,
      new Date().toISOString(),
      runner === "backup" ? 180 : 0,
      runner,
      batchId ?? null,
      identity,
    )
    .run();
  return result.meta.changes ? id : null;
}
export async function expireMuseAttempts(env: Env) {
  // Never release a crashed browser reservation automatically: it may have submitted.
  await env.DB.prepare(
    "UPDATE attempts SET state='uncertain',error='Muse stopped reporting; reconcile before retrying' WHERE runner='muse' AND state IN ('preparing','submitting') AND started_at<?",
  )
    .bind(new Date(Date.now() - 2 * 3600000).toISOString())
    .run();
}
