import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

export interface TeamSlug {
  org: string;
  team: string;
}

export function parseTeamSlug(slug: string): TeamSlug | null {
  const parts = slug.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return { org: parts[0], team: parts[1] };
}

export async function isUserExcludedByTeams(
  octokit: Octokit,
  teamSlugs: string[],
  username: string,
  skipOnFailure: boolean
): Promise<boolean> {
  for (const slug of teamSlugs) {
    const parsed = parseTeamSlug(slug);
    if (!parsed) {
      core.warning(`Invalid team slug '${slug}'. Expected 'org/team'.`);
      continue;
    }
    try {
      const res = await octokit.rest.teams.getMembershipForUserInOrg({
        org: parsed.org,
        team_slug: parsed.team,
        username,
      });
      // Membership states: 'active', 'pending'. Treat active as excluded.
      if (res.status === 200 && res.data.state === "active") {
        core.info(`User ${username} excluded by team ${parsed.org}/${parsed.team}.`);
        return true;
      }
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const msg = e?.message ?? String(e);
      if (skipOnFailure) {
        core.warning(
          `Failed to check membership for ${parsed.org}/${parsed.team} and user ${username} (status ${status}): ${msg}. Skipping enforcement per configuration.`
        );
        return true; // Skip enforcement entirely
      } else {
        core.warning(
          `Failed to check membership for ${parsed.org}/${parsed.team} and user ${username} (status ${status}): ${msg}. Continuing without team exclusion.`
        );
        // Continue to next team
      }
    }
  }
  return false;
}

export function isUserExcludedByList(excludeUsers: string[], username: string): boolean {
  const set = new Set(excludeUsers.map((u) => u.toLowerCase()));
  return set.has(username.toLowerCase());
}