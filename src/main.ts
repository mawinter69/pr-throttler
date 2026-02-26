import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { allowedOpenFromPolicy, parseInputs } from "./config";
import { fetchAuthorPRCounts } from "./graphql";
import { isUserExcludedByList, isUserExcludedByTeams } from "./exclusions";

function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

async function run(): Promise<void> {
  try {
    const inputs = parseInputs();

    const ctx = github.context;
    if (ctx.eventName !== "pull_request" && ctx.eventName !== "pull_request_target") {
      core.info(`Event ${ctx.eventName} is not supported. This action only runs on pull_request events.`);
      core.setOutput("decision", "skipped");
      return;
    }

    const pr = ctx.payload.pull_request as any;
    if (!pr) {
      core.info("No pull_request payload found. Skipping.");
      core.setOutput("decision", "skipped");
      return;
    }

    const owner = ctx.repo.owner;
    const repo = ctx.repo.repo;
    const pull_number = pr.number as number;
    const author = pr.user?.login as string | undefined;
    const isDraft: boolean = !!pr.draft;
    const prState: string = pr.state || "open";

    if (!author) {
      core.warning("Could not determine PR author. Skipping.");
      core.setOutput("decision", "skipped");
      return;
    }

    // Auto-exclude bot users
    const authorType: string | undefined = pr.user?.type;
    const isBotUser = (authorType && authorType.toLowerCase() === "bot") || /\[bot\]$/i.test(author);
    if (isBotUser) {
      core.info(`Author ${author} detected as bot (type=${authorType}). Skipping enforcement.`);
      core.setOutput("decision", "skipped");
      return;
    }

    // Token and Octokit
    const token = inputs.token || process.env.GITHUB_TOKEN;
    if (!token) {
      core.warning("No GitHub token provided or found in environment. Skipping enforcement.");
      core.setOutput("decision", "skipped");
      return;
    }
    const octokit = new Octokit({ auth: token });

    // Exclusions by user
    if (isUserExcludedByList(inputs.excludeUsers, author)) {
      core.info(`Author ${author} is in excludeUsers list. Skipping enforcement.`);
      core.setOutput("decision", "skipped");
      return;
    }

    // Exclusions by teams
    if (inputs.excludeTeams.length > 0) {
      const excluded = await isUserExcludedByTeams(octokit, inputs.excludeTeams, author, inputs.skipOnFailure);
      if (excluded) {
        core.info(`Author ${author} excluded by teams or skipping on failure. Skipping enforcement.`);
        core.setOutput("decision", "skipped");
        return;
      }
    }

    // If drafts don't count and this PR is a draft, skip enforcement entirely
    if (!inputs.countDrafts && isDraft) {
      core.info(`PR #${pull_number} is draft and drafts do not count. Skipping enforcement.`);
      core.setOutput("decision", "ok");
      return;
    }

    // If PR already closed, nothing to do
    if (prState !== "open") {
      core.info(`PR #${pull_number} is not open (state=${prState}). Skipping.`);
      core.setOutput("decision", "skipped");
      return;
    }

    // Fetch counts via single GraphQL round-trip
    let openCount: number;
    let mergedCount: number;
    try {
      const counts = await fetchAuthorPRCounts(
        { token },
        { owner, repo, author, countDrafts: inputs.countDrafts }
      );
      openCount = counts.openCount;
      mergedCount = counts.mergedCount;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (inputs.skipOnFailure) {
        core.warning(`GraphQL query failed: ${msg}. Skipping enforcement per configuration.`);
        core.setOutput("decision", "skipped");
        return;
      }
      throw e;
    }

    // Determine if current PR is included in the openCount search results
    // It's included if:
    // - PR is open (true here) AND author matches (true here) AND
    // - (countDrafts is true) OR (countDrafts is false AND PR is not draft)
    const currentIncluded = inputs.countDrafts ? true : !isDraft;
    const effectiveOpen = openCount - (currentIncluded ? 1 : 0);

    const allowedOpen = allowedOpenFromPolicy(inputs.policy, mergedCount);

    core.info(
      `Author=${author}, openCount(search)=${openCount}, effectiveOpen(excl current)=${effectiveOpen}, mergedCount=${mergedCount}, allowedOpen=${allowedOpen}, isDraft=${isDraft}, countDrafts=${inputs.countDrafts}`
    );

    core.setOutput("openCount", String(effectiveOpen));
    core.setOutput("mergedCount", String(mergedCount));
    core.setOutput("allowedOpen", String(allowedOpen));

    // If effective open PRs already at or above limit, enforce policy
    if (effectiveOpen >= allowedOpen) {
      const actionType: string | undefined = (github.context.payload as any)?.action;

      // Special handling: when countDrafts=false and this is a ready_for_review event, revert to draft instead of closing
      if (!inputs.countDrafts && inputs.revertToDraftOnReady && actionType === "ready_for_review") {
        const backComment = (inputs.backToDraftComment || "").trim();
        if (backComment.length > 0) {
          const commentBody = renderTemplate(backComment, {
            author,
            openCount: effectiveOpen,
            allowedOpen,
            mergedCount,
          });
          try {
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: commentBody,
            });
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            if (inputs.skipOnFailure) {
              core.warning(`Failed to post back-to-draft comment: ${msg}. Skipping enforcement per configuration.`);
              core.setOutput("decision", "skipped");
              return;
            } else {
              core.warning(`Failed to post back-to-draft comment: ${msg}. Continuing to revert to draft.`);
            }
          }
        } else {
          core.info("No backToDraftComment provided; reverting to draft without posting a comment.");
        }

        try {
          // Convert PR back to draft via REST update
          await octokit.rest.pulls.update({
            owner,
            repo,
            pull_number,
            draft: true,
          });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (inputs.skipOnFailure) {
            core.warning(`Failed to revert PR to draft: ${msg}. Skipping enforcement per configuration.`);
            core.setOutput("decision", "skipped");
            return;
          } else {
            throw new Error(`Failed to revert PR to draft: ${msg}`);
          }
        }

        core.info(`PR #${pull_number} reverted to draft due to PR throttling policy.`);
        core.setOutput("decision", "reverted_to_draft");
        return;
      }

      // Default behavior: close the PR
      const commentBody = renderTemplate(inputs.closeComment, {
        author,
        openCount: effectiveOpen,
        allowedOpen,
        mergedCount,
      });

      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: commentBody,
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (inputs.skipOnFailure) {
          core.warning(`Failed to post comment: ${msg}. Skipping enforcement per configuration.`);
          core.setOutput("decision", "skipped");
          return;
        } else {
          core.warning(`Failed to post comment: ${msg}. Continuing to close PR.`);
        }
      }

      try {
        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number,
          state: "closed",
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (inputs.skipOnFailure) {
          core.warning(`Failed to close PR: ${msg}. Skipping enforcement per configuration.`);
          core.setOutput("decision", "skipped");
          return;
        } else {
          throw new Error(`Failed to close PR: ${msg}`);
        }
      }

      if (inputs.labelWhenClosed && inputs.labelWhenClosed.trim().length > 0) {
        try {
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: pull_number,
            labels: [inputs.labelWhenClosed],
          });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          core.warning(`Failed to add label '${inputs.labelWhenClosed}': ${msg}. Continuing.`);
        }
      }

      core.info(`PR #${pull_number} closed due to PR throttling policy.`);
      core.setOutput("decision", "closed");
      return;
    }

    core.info(`PR #${pull_number} within limit. No action taken.`);
    core.setOutput("decision", "ok");
  } catch (error: any) {
    core.setFailed(error?.message ?? String(error));
  }
}

run();