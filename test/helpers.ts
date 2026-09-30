import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Env, Task, Job, Profile } from "../src/types";
export function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../migrations/0001.sql", import.meta.url), "utf8"),
  );
  const api = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt = {
        bind(...values: any[]) {
          args = values;
          return stmt;
        },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
        async first(column?: string) {
          const r = db.prepare(sql).get(...args);
          return column ? r?.[column] : (r ?? null);
        },
        async all() {
          return { results: db.prepare(sql).all(...args), success: true };
        },
      };
      return stmt;
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { api: api as unknown as D1Database, db };
}
export function environment() {
  const { api, db } = database();
  const queued: Task[] = [];
  const env = {
    DB: api,
    TASKS: {
      send: async (task: Task) => {
        queued.push(task);
      },
    },
    NOTION_TOKEN: "test-token",
    NOTION_DATA_SOURCE_ID: "data-source",
    NOTION_TEMPLATE_ID: "template",
    DIGEST_EMAIL: "test@example.com",
    TIME_ZONE: "America/Los_Angeles",
  } as unknown as Env;
  return { env, db, queued };
}
export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "ashby:test:123",
    sourceId: "test",
    company: "Test",
    ats: "ashby",
    title: "Data Scientist, New Grad 2027",
    url: "https://jobs.ashbyhq.com/test/123",
    applyUrl: "https://jobs.ashbyhq.com/test/123/application",
    location: "San Francisco, CA",
    description:
      "Python SQL machine learning and causal inference. Requirements: 1 year of experience. Full-time 2027.",
    postedAt: null,
    employmentType: "FullTime",
    listed: true,
    ...overrides,
  };
}
export function profile(): Profile {
  return {
    verified: true,
    earliestStart: "2027-06-01",
    resumeSha256: "a".repeat(64),
    approvedJobIds: [],
    skills: ["python", "sql"],
    answers: Object.fromEntries(
      Object.entries({
        fullName: "Test Applicant",
        email: "test@example.com",
        phone: "1234567890",
        authorizedUS: "Yes",
        sponsorship: "No",
        earliestStart: "2027-06-01",
      }).map(([key, value]) => [key, { value, verified: true }]),
    ),
  };
}
