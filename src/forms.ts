import type { Profile } from "./types";
export type Field = {
  index: number;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
};
export type Fill = {
  index: number;
  kind: "text" | "select" | "file" | "check";
  value: string;
};
export const normalizedLabel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s*]+/g, " ")
    .replace(/[:?]$/, "")
    .trim();
const aliases: Record<string, string> = {
  "full name": "fullName",
  name: "fullName",
  "first name": "firstName",
  "last name": "lastName",
  email: "email",
  "email address": "email",
  phone: "phone",
  "phone number": "phone",
  linkedin: "linkedin",
  "linkedin url": "linkedin",
  "linkedin profile": "linkedin",
  github: "github",
  "github url": "github",
  location: "location",
  "current location": "location",
  "earliest start date": "earliestStart",
  "when can you start": "earliestStart",
  "are you legally authorized to work in the united states": "authorizedUS",
  "will you now or in the future require sponsorship for employment visa status":
    "sponsorship",
  "do you require visa sponsorship": "sponsorship",
};
export function planFields(
  fields: Field[],
  profile: Profile,
): { fills: Fill[]; blockers: string[] } {
  const fills: Fill[] = [],
    blockers: string[] = [];
  for (const field of fields) {
    const label = normalizedLabel(field.label);
    if (field.type === "file") {
      if (
        /^resume(?:\/cv)?$|^cv$|^resume or cv$|^upload (?:your )?(?:resume|cv)$/.test(
          label,
        )
      ) {
        fills.push({
          index: field.index,
          kind: "file",
          value: "approved resume",
        });
        continue;
      }
      if (field.required) blockers.push(`Unrecognized upload: ${field.label}`);
      continue;
    }
    const key = aliases[label] ?? `exact:${label}`,
      answer = profile.answers[key];
    if (
      field.type === "textarea" &&
      /why|describe|tell us|essay|cover letter|experience|excite|interest/.test(
        label,
      )
    ) {
      blockers.push(`Written response: ${field.label}`);
      continue;
    }
    if (!answer?.verified) {
      if (field.required)
        blockers.push(`Unverified answer: ${field.label || "unlabeled field"}`);
      continue;
    }
    if (field.type === "checkbox") {
      if (key.startsWith("exact:") && answer.value === "Yes")
        fills.push({ index: field.index, kind: "check", value: "Yes" });
      else if (field.required)
        blockers.push(`Consent requires explicit answer: ${field.label}`);
      continue;
    }
    if (field.type === "radio" || field.type === "custom") {
      if (field.required)
        blockers.push(`Unsupported form control: ${field.label}`);
      continue;
    }
    if (field.type === "select") {
      const option = field.options?.find(
        (x) => normalizedLabel(x) === normalizedLabel(answer.value),
      );
      if (!option) blockers.push(`No exact option for: ${field.label}`);
      else fills.push({ index: field.index, kind: "select", value: option });
    } else
      fills.push({ index: field.index, kind: "text", value: answer.value });
  }
  if (!fills.some((f) => f.kind === "file"))
    blockers.push("No recognized resume upload");
  return { fills, blockers };
}
export function profileProblems(profile: Profile): string[] {
  const problems: string[] = [];
  if (!profile.verified)
    problems.push("Application profile has not been verified");
  for (const key of [
    "fullName",
    "email",
    "phone",
    "authorizedUS",
    "sponsorship",
    "earliestStart",
  ])
    if (!profile.answers[key]?.verified) problems.push(`Verify ${key}`);
  if (
    profile.earliestStart !== "2027-06-01" ||
    profile.answers.earliestStart?.value !== "2027-06-01"
  )
    problems.push("Availability must match June 1, 2027");
  if (!/^[a-f0-9]{64}$/i.test(profile.resumeSha256))
    problems.push("Approved resume fingerprint missing");
  return problems;
}
