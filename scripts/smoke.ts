import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const token = (await readFile(".dev.vars", "utf8")).match(
  /^ADMIN_TOKEN=(.+)$/m,
)?.[1];
if (!token) throw new Error("Local token missing");
const call = async (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:8787${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
assert.equal((await fetch("http://127.0.0.1:8787/status")).status, 401);
assert.equal((await call("/setup", {})).status, 200);
const status = (await (await call("/status")).json()) as any;
assert.ok(status.sources.length > 0);
assert.ok(
  status.settings.some((s: any) => s.key === "paused" && s.value === "true"),
);
assert.equal((await call("/settings", { apply_enabled: true })).status, 409);
assert.equal((await call("/preview")).status, 200);
console.log(
  "Local Worker smoke test passed: auth, seeded sources, paused defaults, profile gate, preview.",
);
