# PR Throttler GitHub Action

Enforce a per-author limit on open pull requests based on the author's number of successfully merged PRs in the current repository. When a limit is exceeded, this action posts a configurable comment and closes the PR. It supports excluding specific users or organization teams from enforcement, and uses a single GitHub GraphQL round-trip to retrieve both open and merged PR counts.

Key features
- GraphQL single-call to fetch both open and merged PR counts for the author
- Policy-based thresholds mapping merged PR counts to allowed open PRs
- Configurable message when closing
- Configurable whether draft PRs count towards open PRs
- Bot users are automatically excluded from enforcement
- Exclude users and org teams from enforcement
- Optional label when auto-closing PRs
- Skips enforcement (does not fail job) if permissions or API calls fail, if configured

Permissions required
- pull-requests: write (to close PRs)
- issues: write (to post comments and add labels)
- contents: read
- metadata: read
- members: read (only if you use team-based exclusions)

Inputs
- policy (required): JSON array of threshold rules mapping merged PR counts to allowed open PRs.
  Behavior:
  - Rules are sorted by minMerged ascending; the last rule with minMerged <= mergedCount applies.
  - Gaps between rules are allowed; values between thresholds inherit the previous threshold.
  Fields:
  - minMerged: inclusive lower bound (number)
  - allowedOpen: allowed number of open PRs (number)
  Example:
    [
      { "minMerged": 0, "allowedOpen": 1 },
      { "minMerged": 1, "allowedOpen": 2 },
      { "minMerged": 3, "allowedOpen": 3 }
    ]

- closeComment (required): Comment to post when closing a PR. Placeholders supported:
  - {author}, {openCount}, {allowedOpen}, {mergedCount}

- excludeUsers (optional): Comma-separated list or JSON array of usernames to exclude from enforcement. Bot users are auto-excluded by default; no need to list e.g., dependabot[bot] or renovate[bot].

- excludeTeams (optional): Comma-separated list of org/team slugs to exclude (e.g., acme/maintainers,acme/admins). Requires a token with members: read scope.

- countDrafts (optional; default "true"): Whether drafts count toward open PRs.

- skipOnFailure (optional; default "true"): If true, the action logs a warning and sets decision=skipped when API calls or permissions fail instead of failing the job.

- revertToDraftOnReady (optional; default "true"): When countDrafts=false and the event is ready_for_review, revert the PR back to draft instead of closing it if the author is over the limit.

- backToDraftComment (optional): Comment to post when reverting a PR back to draft on ready_for_review. Placeholders supported: {author}, {openCount}, {allowedOpen}, {mergedCount}.

- labelWhenClosed (optional): A label to add to PRs closed by this action.

- token (optional): GitHub token to use. If omitted, falls back to GITHUB_TOKEN env. For team exclusions, the token must have read:org.

Outputs
- decision: ok | closed | skipped
- openCount: effective open PR count excluding the current PR when applicable
- allowedOpen: allowed open PRs for the author per policy
- mergedCount: merged PR count for the author in the current repo

Event triggers
Run on:
- pull_request types: [opened, reopened, ready_for_review]

Draft PR handling
- Controlled by input countDrafts.
- If true, drafts count toward open PRs and the current PR is included in the "open" count (so the action subtracts 1 for the current PR).
- If false, drafts do not count toward open PRs and if the current PR is draft it will not be included in the open count. When a draft is later converted to ready_for_review, the action re-checks and counts that PR. If the author is over the limit, and revertToDraftOnReady=true, the PR is reverted back to draft and backToDraftComment (if provided) is posted. Otherwise, the PR is closed and closeComment is posted.

Example workflow
Place this in .github/workflows/pr-throttle.yml of the repository where you want enforcement:

name: PR Throttling
on:
  pull_request:
    types: [opened, reopened, ready_for_review]

# Optional: serialize for the same actor to reduce race conditions
concurrency:
  group: pr-throttle-${{ github.actor }}
  cancel-in-progress: false

jobs:
  enforce:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      metadata: read
      members: read  # only required if using excludeTeams
    steps:
      - name: Enforce PR throttling
        uses: your-org/gh-action-pr-throttler@v1
        with:
          policy: |
            [
              { "minMerged": 0, "allowedOpen": 1 },
              { "minMerged": 1, "allowedOpen": 2 },
              { "minMerged": 3, "allowedOpen": 3 }
            ]
          closeComment: |
            Hi {author}, this repository limits open pull requests based on your merged PR history.
            You currently have {openCount} open PR(s). Your limit is {allowedOpen}, given {mergedCount} merged PR(s).
            Please focus on existing PRs before opening more. Thank you.
          excludeTeams: "acme/maintainers,acme/admins"
          countDrafts: "true"
          skipOnFailure: "true"
          revertToDraftOnReady: "true"
          backToDraftComment: |
            Hi {author}, this PR was moved back to draft because your current open PRs ({openCount}) exceed the limit ({allowedOpen}). Please reduce your open PRs or wait until others are merged.
          labelWhenClosed: "auto-closed: throttled"
          # token: ${{ secrets.ORG_READ_TOKEN }} # optional; use if you need read:org for team checks

Notes on team exclusions
- Team membership check uses GET /orgs/{org}/teams/{team_slug}/memberships/{username}
- A status of 200 with state=active indicates the user is a member and will be excluded from enforcement.
- If the check fails and skipOnFailure=true, enforcement is skipped with decision=skipped.

How it works internally
- Determines the PR author and draft state from the event payload.
- Performs a single GraphQL operation that runs two searches:
  - open PRs count for the author in the repo (optionally excluding drafts)
  - merged PRs count for the author in the repo
- Computes the effective open count by subtracting the current PR if it's included in the search.
- Maps mergedCount to allowedOpen per the policy and enforces the limit by commenting and closing if exceeded.

Local development
- Build: npm run build (bundles into dist/index.js via ncc)
- Source: src/main.ts and helpers in src/config.ts, src/graphql.ts, src/exclusions.ts
- Action metadata: action.yml

Edge cases
- Fork PRs: Actions token runs on the target repo and can comment/close PRs.
- Search index lag: GraphQL search counts may lag briefly; acceptable for policy enforcement.
- Missing permissions or API failures: If skipOnFailure=true, the action logs a warning and sets decision=skipped.

License
ISC