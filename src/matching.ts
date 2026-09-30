import type { Fit, Job } from "./types";
export const skills = [
  "python",
  "sql",
  "pytorch",
  "tensorflow",
  "scikit-learn",
  "causal inference",
  "experimentation",
  "a/b testing",
  "statistics",
  "machine learning",
  "spark",
  "nlp",
  "rag",
  "bayesian",
];
export type RoleLane =
  "FDE / Deployment" | "Applied AI" | "Startup SWE" | "ML / Data" | "Other";
export function roleLane(title: string): RoleLane {
  const value = title.toLowerCase();
  if (
    /forward deployed|deployment|customer engineer|solutions engineer/.test(
      value,
    )
  )
    return "FDE / Deployment";
  if (/applied ai|\bai engineer\b/.test(value)) return "Applied AI";
  if (
    /software engineer|product engineer|full.?stack|backend|platform engineer/.test(
      value,
    )
  )
    return "Startup SWE";
  if (
    /machine learning|\bml\b|data scien|research (?:engineer|scientist)|analytics/.test(
      value,
    )
  )
    return "ML / Data";
  return "Other";
}
export function rank(job: Job): Fit {
  const title = job.title.toLowerCase(),
    text = job.description.toLowerCase();
  const bayArea =
    /san francisco|bay area|berkeley|oakland|palo alto|menlo park|mountain view|sunnyvale|santa clara|san jose|san mateo|redwood city|foster city|south san francisco|burlingame|san bruno|fremont|pleasanton|emeryville|hayward|dublin,? ca|san rafael|novato|walnut creek|cupertino|milpitas/i.test(
      job.location,
    );
  const reasons: string[] = [];
  let label: Fit["label"] = "Strong";
  const possible = (r: string) => {
    if (label !== "Skip") label = "Possible";
    reasons.push(r);
  };
  const skip = (r: string) => {
    label = "Skip";
    reasons.push(r);
  };
  if (
    !/machine learning|\bml\b|data scien|applied scien|\bai[ /-](?:ml[ /-])?engineer|research (?:engineer|scientist)|forward deployed|deployment|customer engineer|solutions engineer|software engineer|product engineer|full.?stack|backend/i.test(
      title,
    )
  )
    skip("Outside ML, FDE, Applied AI, or startup-SWE target lanes");
  if (
    /\brecruiter\b|\bsourcer\b|\bsales\b|\bmarketing\b|\bproduct manager\b/.test(
      title,
    )
  )
    skip("Not a technical individual-contributor role");
  if (
    /\bsenior\b|\bsr\.?\b|\bstaff\b|\bprincipal\b|\bdirector\b|\bmanager\b|\blead\b|\bhead of\b|\biii\b|\biv\b/.test(
      title,
    )
  )
    skip("Senior or leadership title");
  if (
    /intern(?:ship)?\b|contract|part.time|temporary/i.test(
      job.employmentType + " " + title,
    )
  )
    skip("Not a permanent full-time role");
  if (!job.listed) skip("Posting is not publicly listed");
  if (!bayArea) possible("Outside the Bay Area or location needs confirmation");
  const years = [
    ...text.matchAll(
      /\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*\+?\s*years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|hands.on\s+|work\s+)?experience/g,
    ),
  ]
    .filter(
      (m) =>
        !/preferred|nice to have|ideally/.test(
          text.slice(Math.max(0, m.index! - 50), m.index! + m[0].length + 25),
        ),
    )
    .map((m) => Number(m[1]));
  if (years.some((y) => y >= 4))
    skip("Experience requirement exceeds the target range");
  else if (years.some((y) => y === 3))
    possible("Three-year experience requirement: stretch role");
  if (
    /(?:ph\.?d\.?|doctorate)\s+(?:is\s+)?required|required[^.!\n]{0,35}(?:ph\.?d\.?|doctorate)/.test(
      text,
    )
  )
    skip("Doctorate explicitly required");
  if (
    /(?:start|join|available)[^.!\n]{0,45}(?:immediately|asap|within \d+ (?:weeks|days)|2026)/.test(
      text,
    )
  )
    skip("Start date conflicts with June 1, 2027");
  const startMatch = text.match(
    /(?:start date|starting|start by)[:\s]+(202\d-\d\d-\d\d)/,
  );
  if (startMatch && startMatch[1] < "2027-06-01")
    skip("Explicit start date precedes June 1, 2027");
  if (
    /(?:start|starting|join)[^.!\n]{0,30}(?:january|february|march|april|may|spring)\s+2027/.test(
      text,
    )
  )
    skip("Early-2027 start precedes availability");
  if (
    /(?:graduat\w*|degree)[^.!\n]{0,60}(?:by|before|in)\s+(?:\w+\s+)?2026/.test(
      text,
    )
  )
    skip("Graduation window excludes May 2027");
  if (/\bph\.?d\.?\b|doctorate/.test(text))
    possible("Check degree requirements and alternatives");
  const matches = skills.filter((s) =>
    new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
      text,
    ),
  );
  if (matches.length < 2) possible("Insufficient evidence of a technical fit");
  else reasons.push(`Resume overlap: ${matches.slice(0, 6).join(", ")}`);
  if (!text.trim()) possible("Missing job description");
  if (
    !/new grad|early career|college grad|graduate|2027/i.test(title) &&
    !years.some((y) => y <= 2)
  )
    possible(
      "Early-career level not confirmed; review experience expectations",
    );
  const lane = roleLane(job.title);
  if (lane !== "ML / Data" && lane !== "Other")
    reasons.push(`Target lane: ${lane}`);
  if (!/2027/.test(text + " " + title))
    reasons.push("2027 start not confirmed; disclose June 1 availability");
  if (bayArea)
    reasons.push(
      /san francisco/i.test(job.location)
        ? "San Francisco location"
        : "Bay Area location",
    );
  const priority =
    (label === "Strong" ? 100 : label === "Possible" ? 40 : 0) +
    (/san francisco/i.test(job.location) ? 20 : bayArea ? 10 : 0) +
    (/2027|new grad|early career/i.test(title) ? 10 : 0);
  return { label, reasons, bayArea, priority };
}
