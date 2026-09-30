import type { Env, Existing, JobRow } from "./types";
import { companyKey, identities, plainTitle } from "./identity";
export async function setting(
  env: Env,
  key: string,
  fallback = "false",
): Promise<string> {
  return (
    (
      await env.DB.prepare("SELECT value FROM settings WHERE key=?")
        .bind(key)
        .first<{ value: string }>()
    )?.value ?? fallback
  );
}
export async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(key, value)
    .run();
}
export async function event(env: Env, kind: string, detail: string) {
  await env.DB.prepare(
    "INSERT INTO events(kind,detail,created_at) VALUES(?,?,?)",
  )
    .bind(kind, detail.slice(0, 1000), new Date().toISOString())
    .run();
}
export async function lock(
  env: Env,
  name: string,
  seconds = 300,
): Promise<string | null> {
  const owner = crypto.randomUUID(),
    now = Date.now();
  const r = await env.DB.prepare(
    "INSERT INTO locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires < ?",
  )
    .bind(name, owner, now + seconds * 1000, now)
    .run();
  return r.meta.changes ? owner : null;
}
export async function unlock(env: Env, name: string, owner: string) {
  await env.DB.prepare("DELETE FROM locks WHERE name=? AND owner=?")
    .bind(name, owner)
    .run();
}
export async function importPages(env: Env, pages: Existing[]) {
  // Call only with a complete, successfully paginated snapshot.
  const records = pages.map((p) => ({
    ...p,
    referral: +p.referral,
    archived: +(p.archived ?? false),
  }));
  const keys = pages.flatMap((p) =>
    identities(p.links).map((identity) => ({ identity, page_id: p.id })),
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM identities"),
    env.DB.prepare("UPDATE existing_pages SET archived=1"),
    env.DB.prepare(
      "INSERT INTO existing_pages(id,company,title,stage,source,links,referral,archived) SELECT json_extract(value,'$.id'),json_extract(value,'$.company'),json_extract(value,'$.title'),json_extract(value,'$.stage'),json_extract(value,'$.source'),json_extract(value,'$.links'),json_extract(value,'$.referral'),json_extract(value,'$.archived') FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET company=excluded.company,title=excluded.title,stage=excluded.stage,source=excluded.source,links=excluded.links,referral=excluded.referral,archived=excluded.archived",
    ).bind(JSON.stringify(records)),
    env.DB.prepare(
      "INSERT OR IGNORE INTO identities(identity,page_id) SELECT json_extract(value,'$.identity'),json_extract(value,'$.page_id') FROM json_each(?)",
    ).bind(JSON.stringify(keys)),
  ]);
  await setSetting(env, "imported_at", new Date().toISOString());
}
export async function duplicate(
  env: Env,
  urls: string[],
  company: string,
  title: string,
): Promise<{ id: string; ambiguous: boolean } | null> {
  for (const key of identities(urls)) {
    const hit = await env.DB.prepare(
      "SELECT page_id FROM identities WHERE identity=?",
    )
      .bind(key)
      .first<{ page_id: string }>();
    if (hit) return { id: hit.page_id, ambiguous: false };
  }
  const pages = await env.DB.prepare("SELECT * FROM existing_pages").all<any>();
  const found = pages.results.find(
    (p) =>
      companyKey(p.company) === companyKey(company) &&
      p.title &&
      plainTitle(p.title) === plainTitle(title),
  );
  return found ? { id: found.id, ambiguous: true } : null;
}
export async function referralHold(
  env: Env,
  company: string,
): Promise<boolean> {
  const pages = await env.DB.prepare(
    "SELECT company FROM existing_pages WHERE referral=1",
  ).all<{ company: string }>();
  return pages.results.some(
    (p) => companyKey(p.company) === companyKey(company),
  );
}
export async function jobRow(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<JobRow>();
}
