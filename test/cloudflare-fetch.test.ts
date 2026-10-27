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

test("manual applications are recorded as submitted in their selected search track", async () => {
  const { env, db } = environment();
  env.NOTION_TOKEN = "token";
  let requestBody: any;
  const notionFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ id: "page-id" });
  };
  await new Notion(env, notionFetch).recordApplication(
    {
      company: "Oklahoma City Thunder",
      title: "Applied AI Engineer Intern / Basketball Operations",
      url: "https://example.com/job/464886",
      source: "Direct application · Paycom",
      location: "Remote — Oklahoma City, OK",
      opportunityType: "Internship",
      searchTrack: "Spring 2027 Flexible Work",
      lane: "Applied Science",
      fit: "Strong",
      schedule: "Remote, up to 29 hours/week",
    },
    "2026-10-27",
  );
  assert.equal(requestBody.properties.Stage.status.name, "Applied");
  assert.equal(requestBody.properties["Date Applied"].date.start, "2026-10-27");
  assert.equal(
    requestBody.properties["Search Track"].select.name,
    "Spring 2027 Flexible Work",
  );
  assert.equal(
    requestBody.properties["Opportunity Type"].select.name,
    "Internship",
  );
  db.close();
});
