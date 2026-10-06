import type { Env, Existing, Fit, Job } from "./types";
import { linksIn } from "./identity";
import { roleLane } from "./matching";
export const extraProperties = {
  Location: { rich_text: {} },
  "Date Found": { date: {} },
  Fit: {
    select: {
      options: [
        { name: "Strong", color: "green" },
        { name: "Possible", color: "yellow" },
        { name: "Skip", color: "gray" },
      ],
    },
  },
  "Needs Your Input": { checkbox: {} },
  "Automation Status": {
    select: {
      options: [
        "Watchlist",
        "Manual check",
        "Review",
        "Ready",
        "Paused",
        "Submitted",
        "Uncertain",
        "Closed",
        "Unsupported",
        "Preview",
      ].map((name) => ({ name })),
    },
  },
  "Role Lane": {
    select: {
      options: [
        "ML Engineering",
        "Data Science",
        "Applied Science",
        "Research",
        "Other",
      ].map((name) => ({ name })),
    },
  },
};
export class Notion {
  // Bind through a wrapper. Cloudflare's native fetch requires the global receiver.
  constructor(
    private env: Env,
    private request: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = (input, init) => fetch(input, init),
  ) {}
  async call(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!this.env.NOTION_TOKEN)
      throw new Error("Notion integration token is missing");
    // Calling a stored native Cloudflare function as `this.request(...)` loses
    // its required global receiver. Invoke a local reference instead.
    const request = this.request;
    const response = await request(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.NOTION_TOKEN}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      throw new Error(
        `Notion ${method} ${path.split("/")[0]} HTTP ${response.status}`,
      );
    return response.json();
  }
  async schema() {
    const s = await this.call(`data_sources/${this.env.NOTION_DATA_SOURCE_ID}`);
    const missing = Object.fromEntries(
      Object.entries(extraProperties).filter(([k]) => !s.properties[k]),
    );
    if (Object.keys(missing).length)
      await this.call(
        `data_sources/${this.env.NOTION_DATA_SOURCE_ID}`,
        "PATCH",
        { properties: missing },
      );
  }
  async pages(): Promise<Existing[]> {
    const result: Existing[] = [];
    let cursor: string | undefined;
    do {
      const d = await this.call(
        `data_sources/${this.env.NOTION_DATA_SOURCE_ID}/query`,
        "POST",
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      for (const p of d.results) result.push(fromPage(p));
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return result;
  }
  page(id: string) {
    return this.call(`pages/${id}`);
  }
  async content(id: string): Promise<string> {
    let cursor: string | undefined;
    let content = "";
    do {
      const d = await this.call(
        `blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      for (const b of d.results) {
        content += JSON.stringify(b[b.type] ?? {}) + "\n";
        if (b.has_children) content += await this.content(b.id);
      }
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return content;
  }
  create(
    job: Job,
    fit: Fit,
    firstSeen: string,
    baseline: boolean,
    marker: string,
  ) {
    return this.call("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.env.NOTION_DATA_SOURCE_ID,
      },
      properties: {
        Company: { title: [rt(job.company)] },
        Position: { rich_text: [rt(job.title, job.url)] },
        Source: { rich_text: [rt(`${job.ats} company board`)] },
        Link: { url: job.applyUrl },
        Stage: { status: { name: "To apply" } },
        Location: { rich_text: [rt(job.location || "Needs confirmation")] },
        "Date Found": { date: { start: firstSeen } },
        Fit: { select: { name: fit.label } },
        "Needs Your Input": { checkbox: true },
        "Automation Status": { select: { name: "Review" } },
        "Role Lane": { select: { name: roleLane(job.title) } },
      },
      children: [
        heading("Action items"),
        todo("Review this opening and any unanswered requirements"),
        heading("Notes on the company"),
        paragraph(""),
        heading("What am I excited about? What will I learn?"),
        paragraph(""),
        heading("Notes on recruiter/hiring manager"),
        paragraph(""),
        heading("To reach out to"),
        paragraph(""),
        heading("Job-search assistant"),
        paragraph(marker),
        paragraph(
          baseline
            ? "Existing opening found during the initial baseline."
            : "Newly discovered since the last successful baseline.",
        ),
        paragraph(
          `Employer posting date: ${job.postedAt ?? "Not provided"}. First found: ${firstSeen}.`,
        ),
        ...fit.reasons.map(paragraph),
        paragraph(
          "Earliest availability: June 1, 2027. Missing employer start dates require truthful disclosure; other requirements must be checked before submission.",
        ),
      ],
    });
  }
  async setAutomation(id: string, status: string, needs: boolean) {
    const page = await this.page(id);
    if (
      page.archived ||
      page.in_trash ||
      page.properties["Automation Status"]?.select?.name === "Paused"
    )
      return;
    await this.call(`pages/${id}`, "PATCH", {
      properties: {
        "Automation Status": { select: { name: status } },
        "Needs Your Input": { checkbox: needs },
      },
    });
  }
  async setLane(id: string, lane: string) {
    await this.call(`pages/${id}`, "PATCH", {
      properties: { "Role Lane": { select: { name: lane } } },
    });
  }
  async setStage(id: string, stage: string) {
    await this.call("pages/" + id, "PATCH", {
      properties: { Stage: { status: { name: stage } } },
    });
  }
  async archive(id: string) {
    await this.call("pages/" + id, "PATCH", { in_trash: true });
  }
  async note(id: string, text: string) {
    await this.call(`blocks/${id}/children`, "PATCH", {
      children: [paragraph(`Application review: ${text}`)],
    });
  }
  async submitted(id: string, when: string) {
    const p = await this.page(id);
    if (p.archived || p.in_trash) throw new Error("Notion page was archived");
    const stage = p.properties.Stage?.status?.name;
    if (stage === "To apply")
      await this.call(`pages/${id}`, "PATCH", {
        properties: {
          Stage: { status: { name: "Applied" } },
          "Date Applied": { date: { start: when } },
          "Automation Status": { select: { name: "Submitted" } },
          "Needs Your Input": { checkbox: false },
        },
      });
    else if (stage !== "Applied")
      throw new Error(
        "Notion stage changed; preserve it and reconcile confirmation",
      );
  }
}
function rt(content: string, url?: string) {
  return {
    type: "text",
    text: {
      content: content.slice(0, 1900),
      ...(url ? { link: { url } } : {}),
    },
  };
}
function heading(text: string) {
  return {
    object: "block",
    type: "heading_1",
    heading_1: { rich_text: [rt(text)] },
  };
}
function paragraph(text: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: text ? [rt(text)] : [] },
  };
}
function todo(text: string) {
  return {
    object: "block",
    type: "to_do",
    to_do: { rich_text: [rt(text)], checked: false },
  };
}
export function fromPage(p: any): Existing {
  const props = p.properties;
  const rich = (key: string) =>
    props[key]?.rich_text ?? props[key]?.title ?? [];
  const txt = (key: string) =>
    rich(key)
      .map((t: any) => t.plain_text ?? t.text?.content ?? "")
      .join("");
  const source = txt("Source");
  return {
    id: p.id,
    company: txt("Company"),
    title: txt("Position"),
    stage: props.Stage?.status?.name ?? "",
    source,
    links: [
      props.Link?.url,
      ...rich("Position").map((t: any) => t.href ?? t.text?.link?.url),
      ...linksIn(txt("Position")),
    ].filter(Boolean),
    referral: /referral/i.test(source),
    archived: p.archived || p.in_trash,
  };
}
