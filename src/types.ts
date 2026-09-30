export type ATS = "ashby" | "greenhouse" | "lever" | "manual";
export type Source = {
  id: string;
  company: string;
  ats: ATS;
  board?: string;
  careerUrl?: string;
  referral?: boolean;
  note?: string;
};
export type Job = {
  id: string;
  sourceId: string;
  company: string;
  ats: ATS;
  title: string;
  url: string;
  applyUrl: string;
  location: string;
  description: string;
  postedAt: string | null;
  employmentType: string;
  listed: boolean;
};
export type Fit = {
  label: "Strong" | "Possible" | "Skip";
  reasons: string[];
  bayArea: boolean;
  priority: number;
};
export type Answer = { value: string; verified: boolean };
export type Profile = {
  verified: boolean;
  earliestStart: string;
  resumeSha256: string;
  answers: Record<string, Answer>;
  approvedJobIds: string[];
  approvedJobHashes?: Record<string, string>;
  skills: string[];
};
export type Task =
  | { type: "scan"; sourceId: string }
  | { type: "sync"; jobId: string }
  | { type: "apply"; jobId: string; dryRun?: boolean }
  | { type: "categorize"; pageId: string; lane: string }
  | { type: "digest" }
  | { type: "import" };
export interface Env {
  DB: D1Database;
  TASKS: Queue<Task>;
  BROWSER: Fetcher;
  NOTION_TOKEN?: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_TEMPLATE_ID: string;
  ADMIN_TOKEN?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER?: string;
  DIGEST_EMAIL: string;
  TIME_ZONE: string;
  PROFILE_JSON?: string;
  RESUME_BASE64?: string;
}
export interface JobRow {
  id: string;
  source_id: string;
  data: string;
  fit: Fit["label"];
  reasons: string;
  first_seen: string;
  last_seen: string;
  baseline: number;
  open: number;
  notion_id: string | null;
  automation: string;
  needs_input: number;
}
export type Existing = {
  id: string;
  company: string;
  title: string;
  stage: string;
  source: string;
  links: string[];
  referral: boolean;
  archived?: boolean;
};
