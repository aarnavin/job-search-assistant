import tasks from "../.github/build-tasks.json";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error("GitHub repository and workflow token are required");
}

async function github(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...init?.headers,
      },
    },
  );
  if (!response.ok)
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

const issues = (await github("issues?state=all&per_page=100")) as Array<{
  title: string;
  state: string;
  pull_request?: unknown;
}>;
const buildIssues = issues.filter(
  (issue) => !issue.pull_request && /^\[Build \d+\]/.test(issue.title),
);
if (buildIssues.some((issue) => issue.state === "open")) {
  console.log("An active build task is already open");
} else {
  const next = tasks.findIndex(
    (_, index) =>
      !buildIssues.some((issue) =>
        issue.title.startsWith(`[Build ${String(index + 1).padStart(2, "0")}]`),
      ),
  );
  if (next < 0) {
    console.log("All planned build tasks have been opened");
  } else {
    const task = tasks[next];
    const title = `[Build ${String(next + 1).padStart(2, "0")}] ${task.title}`;
    const body = `${task.goal}\n\n**Done when:** ${task.done}\n\nClose this issue after shipping the change. The next task opens on the following scheduled run.`;
    await github("issues", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    console.log(`Opened ${title}`);
  }
}
