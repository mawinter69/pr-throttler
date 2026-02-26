import * as core from "@actions/core";

export interface PolicyRule {
  minMerged: number;
  allowedOpen: number;
}

export interface Inputs {
  policy: PolicyRule[];
  closeComment: string;
  excludeUsers: string[];
  excludeTeams: string[]; // org/team-slug
  countDrafts: boolean;
  skipOnFailure: boolean;
  revertToDraftOnReady: boolean;
  backToDraftComment: string;
  labelWhenClosed?: string;
  token?: string;
}

export function parseInputs(): Inputs {
  const policyStr = core.getInput("policy", { required: true }).trim();
  let policy: PolicyRule[] = [];
  try {
    policy = JSON.parse(policyStr);
    if (!Array.isArray(policy)) {
      throw new Error("policy must be a JSON array");
    }
    policy.forEach((r, idx) => {
      if (
        typeof r.allowedOpen !== "number" ||
        typeof r.minMerged !== "number"
      ) {
        throw new Error(`Invalid policy rule at index ${idx}`);
      }
    });
  } catch (e: any) {
    throw new Error(`Failed to parse 'policy' input: ${e.message}`);
  }

  const closeComment = core.getInput("closeComment", { required: true });

  const excludeUsersRaw = core.getInput("excludeUsers") || "";
  const excludeUsers = parseListOrJsonArray(excludeUsersRaw);

  const excludeTeamsRaw = core.getInput("excludeTeams") || "";
  const excludeTeams = parseListOrJsonArray(excludeTeamsRaw);

  const countDraftsStr = core.getInput("countDrafts") || "true";
  const countDrafts = countDraftsStr.toLowerCase() === "true";

  const skipOnFailureStr = core.getInput("skipOnFailure") || "true";
  const skipOnFailure = skipOnFailureStr.toLowerCase() === "true";

  const revertToDraftOnReadyStr = core.getInput("revertToDraftOnReady") || "true";
  const revertToDraftOnReady = revertToDraftOnReadyStr.toLowerCase() === "true";

  const backToDraftComment = core.getInput("backToDraftComment") || "";

  const labelWhenClosed = core.getInput("labelWhenClosed") || undefined;

  const token = core.getInput("token") || process.env.GITHUB_TOKEN || process.env.TOKEN || undefined;

  return {
    policy,
    closeComment,
    excludeUsers,
    excludeTeams,
    countDrafts,
    skipOnFailure,
    revertToDraftOnReady,
    backToDraftComment,
    labelWhenClosed,
    token,
  };
}

function parseListOrJsonArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v).trim()).filter((v) => v.length);
    }
  } catch {
    // not JSON, fall through to CSV
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length);
}

export function allowedOpenFromPolicy(policy: PolicyRule[], mergedCount: number): number {
  if (policy.length === 0) return 1;

  // Threshold selection:
  // Sort by minMerged ascending and pick the last rule where minMerged <= mergedCount.
  const sorted = [...policy].sort((a, b) => a.minMerged - b.minMerged);
  let selected: PolicyRule = sorted[0];
  for (const rule of sorted) {
    if (mergedCount >= rule.minMerged) {
      selected = rule;
    } else {
      break;
    }
  }
  return selected.allowedOpen;
}
