import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { museInstructions } from "../src/connector";

const [command, ...args] = process.argv.slice(2);
if (!process.env.WORKER_URL) throw new Error("Load the local .env file first");
const base = new URL(process.env.WORKER_URL);
if (base.protocol !== "https:" && base.hostname !== "localhost")
  throw new Error("HTTPS required");
await mkdir("private", { recursive: true, mode: 0o700 });
if (command === "setup") {
  let token: string;
  try {
    token = (await readFile("private/muse-token.txt", "utf8")).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    token = Buffer.from(randomBytes(32)).toString("hex");
    await writeFile("private/muse-token.txt", token + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "Unexpected local connector token; resolve before deployment",
    );
  await chmod("private/muse-token.txt", 0o600);
  execFileSync("npx", ["wrangler", "secret", "put", "MUSE_TOKEN"], {
    input: token,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const packet = `# Connect your existing Muse\n\nPaste this into Muse:\n\nCreate a custom connector named Job Search Assistant for my existing tracker.\nOpenAPI document: ${base.origin}/agent/openapi.json\nMCP alternative: ${base.origin}/agent/mcp (Streamable HTTP, protocol 2025-06-18).\nAuthentication: Bearer token. Ask me for the credential through your secure credential flow; do not ask me to paste it into ordinary chat. Read ${base.origin}/agent/instructions using the same Authorization header and save those instructions for future job tasks.\n\nThe connector credential is saved on this Mac in private/muse-token.txt. Enter its contents only in Muse's secure credential prompt. It is separate from the admin token.\n\nFirst test: call connection_status and list_jobs with refresh=true, limit=1. Read one existing Notion entry. Report the actual result; do not claim the connection or uploads work until tested. Submissions are disabled.\n\nNext: get_profile shows facts requiring my verification. Prepare a draft batch for a selected job; get_materials provides a private authenticated resume endpoint. Download privately with the connector header and test an upload without submitting. A verified profile and batch approval are required before a fill-only reservation.\n\nAfter real connection/upload tests, return their evidence to Codex. Codex records these tests and enables only the selected pilot application, after my job approval. Full launch requires a confirmed pilot. At launch the service disables the daily email digest.\n\n## Daily commands\n\n- Review these jobs and prepare an application batch.\n- Find spring contracts paying at least $40/hour.\n- Apply to the specific jobs I approve in this batch.\n- What needs my answer?\n\n## Saved agent instructions\n\n${museInstructions}`;
  await writeFile("private/muse-setup.md", packet, { mode: 0o600 });
  const profile = JSON.parse(await readFile("private/profile.json", "utf8"));
  const review = `# Application facts — owner review\n\nThese are local draft answers. Please confirm or correct them in your conversation with Codex before applications are enabled. Facts are not marked verified by this setup script.\n\n${Object.entries(
    profile.answers ?? {},
  )
    .map(
      ([key, answer]: [string, any]) =>
        `- **${key}**: ${answer.value || "Not supplied"} (${answer.verified ? "verified" : "needs your confirmation"})`,
    )
    .join(
      "\n",
    )}\n\n- Full-time availability: June 1, 2027.\n- Spring workload: 10–20 hours per week (you selected this).\n- Earliest Spring 2027 start date: ${profile.availability?.["spring-flex"]?.earliestStart?.value ?? "awaiting your answer"}.\n- New written responses: draft for your review.\n- Resume: use the existing private resume unchanged.\n\nAfter your confirmation, Codex can update the verified profile and upload it privately.\n`;
  await writeFile("private/profile-review.md", review, { mode: 0o600 });
  console.log(
    "Connector secret stored in Cloudflare. Setup instructions: private/muse-setup.md. Credential: private/muse-token.txt (not printed). Submissions remain disabled.",
  );
} else {
  const token = (await readFile("private/muse-token.txt", "utf8")).trim();
  const call = async (name: string, body: unknown = {}) => {
    const response = await fetch(new URL(`/agent/tools/${name}`, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        `Connector HTTP ${response.status}: ${JSON.stringify(result)}`,
      );
    return result;
  };
  if (command === "smoke") {
    console.log(
      JSON.stringify(
        {
          connection: await call("connection_status"),
          sample: await call("list_jobs", { limit: 1 }),
        },
        null,
        2,
      ),
    );
    const admin = await fetch(new URL("/status", base), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (admin.status !== 401)
      throw new Error("Scoped token unexpectedly reached an admin route");
    const mcp = async (message: unknown) => {
      const response = await fetch(new URL("/agent/mcp", base), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      return response.json() as Promise<any>;
    };
    const initialized = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "tracker-smoke", version: "1" },
        capabilities: {},
      },
    });
    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (!initialized.result?.protocolVersion || !listed.result?.tools?.length)
      throw new Error("Invalid MCP discovery response");
    console.log(
      `MCP initialization and discovery passed (${listed.result.tools.length} tools).`,
    );
    console.log(
      "Scoped credential cannot access admin routes. This HTTP smoke test does not count as a real Muse connection/upload test.",
    );
  } else if (command === "tool" && args[0]) {
    console.log(
      JSON.stringify(
        await call(
          args[0],
          args[1] ? JSON.parse(await readFile(args[1], "utf8")) : {},
        ),
        null,
        2,
      ),
    );
  } else
    throw new Error("Use setup, smoke, or tool TOOL_NAME [PRIVATE_JSON_FILE]");
}
