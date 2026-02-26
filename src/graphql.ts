import { graphql as graphqlRequest } from "@octokit/graphql";

export interface PRCounts {
  openCount: number;
  mergedCount: number;
}

export interface GraphQLDeps {
  token: string;
}

export async function fetchAuthorPRCounts(
  deps: GraphQLDeps,
  params: {
    owner: string;
    repo: string;
    author: string;
    countDrafts: boolean;
  }
): Promise<PRCounts> {
  const { token } = deps;
  const { owner, repo, author, countDrafts } = params;

  // Build search queries
  // We use type: ISSUE to enable issueCount on SearchResultItemConnection, and constrain with is:pr.
  // Current repo and author scope only.
  const base = `repo:${owner}/${repo} is:pr author:${author}`;
  const openQuery = countDrafts ? `${base} is:open` : `${base} is:open -is:draft`;
  const mergedQuery = `${base} is:merged`;

  const graphqlWithAuth = graphqlRequest.defaults({
    headers: { authorization: `token ${token}` },
  });

  const query = `
    query($openQuery: String!, $mergedQuery: String!) {
      open: search(query: $openQuery, type: ISSUE) { issueCount }
      merged: search(query: $mergedQuery, type: ISSUE) { issueCount }
    }
  `;

  const data = await graphqlWithAuth<{ open: { issueCount: number }; merged: { issueCount: number } }>(query, {
    openQuery,
    mergedQuery,
  });

  return {
    openCount: data.open.issueCount,
    mergedCount: data.merged.issueCount,
  };
}