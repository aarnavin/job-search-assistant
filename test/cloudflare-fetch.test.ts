import { test } from "node:test";
import assert from "node:assert/strict";
import { Notion } from "../src/notion";
import { fetchJobs } from "../src/sources";
import { environment } from "./helpers";
test("Notion and job feeds call injected fetch without losing its receiver", async () => {
  const { env, db } = environment();
  env.NOTION_TOKEN = "token";
  let notionThis: unknown, feedThis: unknown;
  const notionFetch = function (this: unknown) {
    notionThis = this;
    return Promise.resolve(Response.json({ properties: {} }));
  };
  await new Notion(env, notionFetch as typeof fetch).call("data_sources/test");
  assert.equal(notionThis, undefined);
  const feedFetch = function (this: unknown) {
    feedThis = this;
    return Promise.resolve(Response.json({ jobs: [] }));
  };
  await fetchJobs(
    { id: "test", company: "Test", ats: "ashby", board: "test" },
    feedFetch as typeof fetch,
  );
  assert.equal(feedThis, undefined);
  db.close();
});
