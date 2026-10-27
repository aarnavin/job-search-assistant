import type {
  ContractOpportunity,
  Env,
  Existing,
  Fit,
  Job,
  ManualApplication,
  TrackerSection,
} from "./types";
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
  "Opportunity Type": {
    select: {
      options: ["Full-time", "Contractor", "Internship"].map((name) => ({
        name,
      })),
    },
  },
  "Search Track": {
    select: {
      options: ["Full-time 2027", "Spring 2027 Flexible Work"].map((name) => ({
        name,
      })),
    },
  },
  "Tracker Section": {
    select: {
      options: [
        "1 · Application History",
        "2 · New Listings",
        "3 · Company Watchlist",
      ].map((name) => ({ name })),
    },
  },
  Compensation: { rich_text: {} },
  Schedule: { rich_text: {} },
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
    const changes: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(extraProperties)) {
      const current = s.properties[key];
      if (!current) {
        changes[key] = definition;
        continue;
      }
      if ("select" in definition && definition.select.options) {
        const currentOptions = current.select?.options ?? [];
        const currentNames = new Set(
          currentOptions.map((option: { name: string }) => option.name),
        );
        const additions = definition.select.options.filter(
          (option) => !currentNames.has(option.name),
        );
        if (additions.length)
          changes[key] = {
            select: { options: [...currentOptions, ...additions] },
          };
      }
    }
    if (Object.keys(changes).length)
      await this.call(
        `data_sources/${this.env.NOTION_DATA_SOURCE_ID}`,
        "PATCH",
        { properties: changes },
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
        "Opportunity Type": { select: { name: "Full-time" } },
        "Search Track": { select: { name: "Full-time 2027" } },
        "Tracker Section": { select: { name: "2 · New Listings" } },
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
  createContract(opportunity: ContractOpportunity, foundAt: string) {
    return this.call("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.env.NOTION_DATA_SOURCE_ID,
      },
      properties: {
        Company: { title: [rt(opportunity.company)] },
        Position: { rich_text: [rt(opportunity.title, opportunity.url)] },
        Source: {
          rich_text: [rt(`Contract lead · ${opportunity.platform}`)],
        },
        Link: { url: opportunity.url },
        Stage: { status: { name: "To apply" } },
        Location: { rich_text: [rt(opportunity.location)] },
        "Date Found": { date: { start: foundAt } },
        Fit: { select: { name: opportunity.fit } },
        "Needs Your Input": { checkbox: true },
        "Automation Status": { select: { name: "Review" } },
        "Role Lane": { select: { name: opportunity.lane } },
        "Opportunity Type": { select: { name: "Contractor" } },
        "Search Track": {
          select: { name: "Spring 2027 Flexible Work" },
        },
        "Tracker Section": { select: { name: "2 · New Listings" } },
        Compensation: { rich_text: [rt(opportunity.compensation)] },
        Schedule: { rich_text: [rt(opportunity.schedule)] },
      },
      children: [
        heading("Contract opportunity"),
        paragraph(`Pay: ${opportunity.compensation}`),
        paragraph(`Schedule: ${opportunity.schedule}`),
        ...opportunity.reasons.map(paragraph),
        ...(opportunity.caveat
          ? [heading("Check before applying"), paragraph(opportunity.caveat)]
          : []),
        heading("Action items"),
        todo(
          "Confirm current project availability and complete the platform assessment",
        ),
        todo(
          "Review contractor terms, paid-task rules, and weekly hour limits",
        ),
      ],
    });
  }
  createFlexible(job: Job, fit: Fit, foundAt: string, marker: string) {
    const lane = roleLane(job.title);
    return this.call("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.env.NOTION_DATA_SOURCE_ID,
      },
      properties: {
        Company: { title: [rt(job.company)] },
        Position: { rich_text: [rt(job.title, job.url)] },
        Source: { rich_text: [rt(`${job.ats} flexible-work board`)] },
        Link: { url: job.applyUrl },
        Stage: { status: { name: "To apply" } },
        Location: {
          rich_text: [rt(job.location || "Remote eligibility unclear")],
        },
        "Date Found": { date: { start: foundAt } },
        Fit: { select: { name: fit.label } },
        "Needs Your Input": { checkbox: true },
        "Automation Status": { select: { name: "Review" } },
        "Role Lane": {
          select: { name: lane === "Other" ? "Applied Science" : lane },
        },
        "Opportunity Type": { select: { name: "Contractor" } },
        "Search Track": {
          select: { name: "Spring 2027 Flexible Work" },
        },
        "Tracker Section": { select: { name: "2 · New Listings" } },
      },
      children: [
        heading("Spring 2027 flexible work"),
        ...fit.reasons.map(paragraph),
        heading("Action items"),
        todo(
          "Confirm the hourly rate, weekly cap, and Spring 2027 availability",
        ),
        todo("Review contractor terms and any assessment before applying"),
        paragraph(marker),
      ],
    });
  }
  async tagSearchTrack(
    id: string,
    opportunityType: ManualApplication["opportunityType"],
    searchTrack: ManualApplication["searchTrack"],
  ) {
    await this.call(`pages/${id}`, "PATCH", {
      properties: {
        "Opportunity Type": { select: { name: opportunityType } },
        "Search Track": { select: { name: searchTrack } },
      },
    });
  }
  async recordApplication(
    application: ManualApplication,
    appliedAt: string,
    existingPageId?: string,
  ) {
    const properties = {
      Company: { title: [rt(application.company)] },
      Position: { rich_text: [rt(application.title, application.url)] },
      Source: { rich_text: [rt(application.source)] },
      Link: { url: application.url },
      Stage: { status: { name: "Applied" } },
      "Date Applied": { date: { start: appliedAt } },
      "Date Found": { date: { start: appliedAt } },
      Location: { rich_text: [rt(application.location)] },
      Fit: { select: { name: application.fit } },
      "Needs Your Input": { checkbox: false },
      "Automation Status": { select: { name: "Submitted" } },
      "Role Lane": { select: { name: application.lane } },
      "Opportunity Type": { select: { name: application.opportunityType } },
      "Search Track": { select: { name: application.searchTrack } },
      "Tracker Section": {
        select: { name: "1 · Application History" },
      },
      ...(application.compensation
        ? { Compensation: { rich_text: [rt(application.compensation)] } }
        : {}),
      ...(application.schedule
        ? { Schedule: { rich_text: [rt(application.schedule)] } }
        : {}),
    };
    if (existingPageId)
      return this.call(`pages/${existingPageId}`, "PATCH", { properties });
    return this.call("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.env.NOTION_DATA_SOURCE_ID,
      },
      properties,
      children: [
        heading("Application record"),
        paragraph(`Applied manually on ${appliedAt}.`),
        ...(application.notes ?? []).map(paragraph),
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
  async setTrackerSection(id: string, section: TrackerSection) {
    await this.call(`pages/${id}`, "PATCH", {
      properties: { "Tracker Section": { select: { name: section } } },
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
          "Tracker Section": {
            select: { name: "1 · Application History" },
          },
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
    trackerSection: props["Tracker Section"]?.select?.name,
  };
}

export function desiredTrackerSection(page: Existing): TrackerSection {
  if (!page.title.trim()) return "3 · Company Watchlist";
  if (page.stage && page.stage !== "To apply") return "1 · Application History";
  return "2 · New Listings";
}
