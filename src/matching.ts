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
  "ML Engineering" | "Data Science" | "Applied Science" | "Research" | "Other";

export function roleLane(title: string): RoleLane {
  const value = title.toLowerCase();
  if (
    /\bapplied (?:ai |ml |machine learning )?scientist\b|\bforward deployed (?:ai )?scientist\b|\bai scientist\b/.test(
      value,
    )
  )
    return "Applied Science";
  if (/\bdata scien(?:tist|ce engineer|ce researcher)\b/.test(value))
    return "Data Science";
  if (
    /\b(?:machine learning|ml|ai\/ml) engineer\b|\bml scientist\b/.test(value)
  )
    return "ML Engineering";
  if (
    /\b(?:research (?:scientist|engineer|associate)|quantitative researcher|ai researcher)\b/.test(
      value,
    )
  )
    return "Research";
  return "Other";
}

function experienceYears(text: string): number[] {
  const years: number[] = [];
  const patterns = [
    /\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*\+?\s*years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|hands-on\s+|work\s+)?experience\b/g,
    /\b(?:at least|minimum of|more than)\s+(\d{1,2})\s*years?\b/g,
    /\bexperience\s*(?:of|:)?\s*(\d{1,2})\s*\+?\s*years?\b/g,
    /\b(\d{1,2})\s*\+?\s*years?\s+(?:in|with|working on|building)\b/g,
    /\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*\+?\s*years?\b/g,
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) years.push(Number(match[1]));
  return years;
}

function earlyCareerEvidence(title: string, text: string) {
  const explicit =
    /\b(?:new(?:ly)?[ -]?grad(?:uate)?|recent[ -]?grad(?:uate)?|college[ -]?grad(?:uate)?|early[ -]?career|entry[ -]?level|graduate (?:role|program|position|hire)|campus (?:hire|recruit(?:ing|ment)|graduate))\b/i;
  const graduation =
    /\b(?:2027\s+(?:graduate|grad)|(?:graduating|graduates|class of)\s+(?:in\s+)?2027)\b/i;
  const associateTitle =
    /\bassociate (?:applied |research |data )?(?:scientist|researcher)\b/i;
  const titleMatch =
    title.match(explicit) ??
    title.match(graduation) ??
    title.match(associateTitle) ??
    title.match(/\b(?:university grad|graduate|campus|junior)\b/i);
  if (titleMatch) return "Employer title says “" + titleMatch[0] + "”";
  const bodyMatch = text.match(explicit) ?? text.match(graduation);
  if (bodyMatch) return "Employer description says “" + bodyMatch[0] + "”";
  if (
    /\bno (?:prior |professional )?experience (?:required|necessary)\b/i.test(
      text,
    )
  )
    return "Employer says no prior experience is required";
  const lowYearMatches = [
    ...text.matchAll(
      /\b([012])(?:\s*[-–]\s*[012])?\s*\+?\s*years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|research\s+|industry\s+|working\s+|hands-on\s+|work\s+)?experience\b/gi,
    ),
  ].filter((match) => {
    const before = text.slice(
      Math.max(0, (match.index ?? 0) - 100),
      match.index,
    );
    return !/(?:nice to have|preferred|bonus|desirable|ideally)[^.!?]{0,100}$/i.test(
      before,
    );
  });
  if (lowYearMatches.length)
    return (
      "Employer lists " +
      Math.min(...lowYearMatches.map((match) => Number(match[1]))) +
      " year(s) as a minimum experience level"
    );
  return null;
}

export function rank(job: Job): Fit {
  const title = job.title.toLowerCase();
  const text = job.description.toLowerCase();
  const lane = roleLane(job.title);
  const bayArea =
    /san francisco|bay area|berkeley|oakland|palo alto|menlo park|mountain view|sunnyvale|santa clara|san jose|san mateo|redwood city|foster city|south san francisco|burlingame|san bruno|fremont|pleasanton|emeryville|hayward|dublin,? ca|san rafael|novato|walnut creek|cupertino|milpitas/i.test(
      job.location,
    );
  const years = experienceYears(text);
  const evidence = earlyCareerEvidence(job.title, job.description);
  const reasons: string[] = [];
  let label: Fit["label"] = "Strong";
  const possible = (reason: string) => {
    if (label !== "Skip") label = "Possible";
    reasons.push(reason);
  };
  const skip = (reason: string) => {
    label = "Skip";
    reasons.push(reason);
  };

  if (lane === "Other")
    skip("Outside ML, data science, applied science, or research roles");
  if (
    /\b(?:software|frontend|front-end|backend|back-end|full.?stack|product|platform|deployment|forward deployed) engineer\b/.test(
      title,
    ) &&
    lane !== "Applied Science"
  )
    skip("Software or deployment engineering is outside the current search");
  if (
    /\b(?:senior|sr\.?|staff|principal|director|manager|lead|head of|ii|iii|iv)\b/.test(
      title,
    )
  )
    skip("Senior or leadership title");
  if (/\bph\.?d\.?\b/.test(title)) skip("PhD-specific title");
  if (
    /intern(?:ship)?\b|contract|part.time|temporary/i.test(
      job.employmentType + " " + title,
    )
  )
    skip("Not a permanent full-time role");
  if (!job.listed) skip("Posting is not publicly listed");
  if (!text.trim())
    skip(
      "Employer description is missing; early-career eligibility cannot be verified",
    );
  if (years.some((year) => year >= 3))
    skip(
      "Posting mentions at least three years of experience; hold for manual review",
    );
  if (
    /(?:ph\.?d\.?|doctorate)[^.!\n]{0,70}required|required[^.!\n]{0,35}(?:ph\.?d\.?|doctorate)/.test(
      text,
    ) &&
    !/(?:m\.?sc?\.?|master.?s)[^.!\n]{0,25}\bor\b[^.!\n]{0,20}(?:ph\.?d\.?|doctorate)/.test(
      text,
    )
  )
    skip("Doctorate explicitly required");
  if (
    /\b(?:ph\.?d\.?|doctorate)\s+in\b/.test(text) &&
    !/(?:m\.?sc?\.?|master.?s)[^.!\n]{0,25}\bor\b[^.!\n]{0,20}(?:ph\.?d\.?|doctorate)/.test(
      text,
    )
  )
    skip("Doctorate-only qualification");
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
  const graduation2026 = text.match(
    /(?:graduat\w*|degree)[^.!\n]{0,60}(?:by|before|in)\s+(?:\w+\s+)?2026/,
  );
  if (
    graduation2026 &&
    !/^\s*(?:or|through|to|[-–])\s+(?:\w+\s+)?2027\b/.test(
      text.slice(
        (graduation2026.index ?? 0) + graduation2026[0].length,
        (graduation2026.index ?? 0) + graduation2026[0].length + 40,
      ),
    )
  )
    skip("Graduation window excludes May 2027");
  if (/\bph\.?d\.?\b|doctorate/.test(text))
    possible("Check degree requirements and alternatives");
  if (
    /\bmaster.?s university grad\b/.test(title) ||
    /\bm\.?sc\.?\s+or\s+ph\.?d\.?\b/.test(text)
  )
    possible("Confirm graduate-degree requirement");
  if (!evidence)
    skip(
      "No explicit new-grad, early-career, or 0–2-year evidence in the employer posting",
    );
  else reasons.push("Early-career evidence: " + evidence);
  if (!bayArea) possible("Outside the Bay Area or location needs confirmation");

  const matches = skills.filter((skill) =>
    new RegExp(
      "\\b" + skill.replace(/[.*+?^$()|[\]{}]/g, "\\$&") + "\\b",
      "i",
    ).test(text),
  );
  if (matches.length < 2) possible("Insufficient evidence of a technical fit");
  else reasons.push("Resume overlap: " + matches.slice(0, 6).join(", "));
  reasons.push("Target lane: " + lane);
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
  const finalLabel = label as Fit["label"];
  return {
    label: finalLabel,
    reasons,
    bayArea,
    priority,
    earlyCareerVerified: !!evidence && finalLabel !== "Skip",
  };
}
