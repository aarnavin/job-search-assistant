import { readFile } from "node:fs/promises";
const [command, ...args] = process.argv.slice(2);
if (!process.env.WORKER_URL || !process.env.ADMIN_TOKEN)
  throw new Error(
    "Set WORKER_URL and ADMIN_TOKEN locally; do not paste tokens into chat.",
  );
const base = new URL(process.env.WORKER_URL);
if (
  base.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(base.hostname)
)
  throw new Error("HTTPS required");
let path = "",
  method = "POST",
  body: unknown = {};
switch (command) {
  case "status":
    path = "/status";
    method = "GET";
    break;
  case "existing":
    path = "/existing";
    method = "GET";
    break;
  case "cleanup-preview":
    path = "/cleanup-preview";
    method = "GET";
    break;
  case "reclassify":
    path = "/maintenance";
    body = { action: "reclassify" };
    break;
  case "reject-vals":
    path = "/maintenance";
    body = { action: "reject-vals", pageId: args[0] };
    break;
  case "archive-unverified":
    path = "/maintenance";
    body = {
      action: "archive-unverified",
      pageId: args[0],
      expectedTitle: args[1],
    };
    break;
  case "shortlist":
    path = "/shortlist";
    method = "GET";
    break;
  case "preview":
    path = "/preview";
    method = "GET";
    break;
  case "digest-preview":
    path = "/digest-preview";
    method = "GET";
    break;
  case "setup":
    path = "/setup";
    break;
  case "categorize":
    path = "/categorize";
    break;
  case "pause":
    path = "/settings";
    body = { paused: true };
    break;
  case "resume":
    path = "/settings";
    body = { paused: false };
    break;
  case "enable":
  case "disable":
    if (!["sync", "email", "apply"].includes(args[0]))
      throw new Error("Use sync, email, or apply");
    path = "/settings";
    body = { [args[0] + "_enabled"]: command === "enable" };
    break;
  case "scan":
  case "sync":
  case "digest":
    path = "/run";
    body = { type: command };
    break;
  case "sync-shortlist":
    path = "/run";
    body = { type: "sync-shortlist" };
    break;
  case "sync-job":
    path = "/run";
    body = { type: "sync-job", jobId: args[0] };
    break;
  case "fill-preview":
    path = "/run";
    body = { type: "apply", jobId: args[0], dryRun: true };
    break;
  case "apply":
    if (args[1] !== "--submit") throw new Error("Explicit --submit required");
    path = "/run";
    body = { type: "apply", jobId: args[0], dryRun: false };
    break;
  case "profile":
    path = "/profile";
    body = {
      profile: JSON.parse(await readFile("private/profile.json", "utf8")),
      resumeBase64: await readFile("private/resume.pdf", "base64"),
    };
    break;
  case "retry-pre-submit":
    path = "/reconcile";
    body = { action: command, jobId: args[0] };
    break;
  case "approve-role":
    if (args[1] !== "--reviewed")
      throw new Error("Read the full role first, then pass --reviewed");
    path = "/approve-role";
    body = { jobId: args[0], reviewed: true };
    break;
  case "attach-notion":
    path = "/reconcile";
    body = { action: command, jobId: args[0], pageId: args[1] };
    break;
  default:
    throw new Error(
      "Commands: setup, status, existing, shortlist, preview, digest-preview, categorize, pause, resume, enable/disable sync|email|apply, scan, sync, sync-shortlist, digest, profile, fill-preview JOB_ID, apply JOB_ID --submit, retry-pre-submit JOB_ID, attach-notion JOB_ID PAGE_ID",
    );
}
const response = await fetch(new URL(path, base), {
  method,
  headers: {
    Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
    "Content-Type": "application/json",
  },
  ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  signal: AbortSignal.timeout(120000),
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
