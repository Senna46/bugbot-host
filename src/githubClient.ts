// GitHub API client for pr-shadow.
// Uses a GitHub App to discover repositories from installations (same
// set as Fixooly) and a user PAT for PR create/update/comment/check
// reads so mirror PRs are authored by Senna46.
// Limitations: Rate limiting is handled by Octokit built-in throttling.
//   Check name matching is tied to Cursor's "Cursor Bugbot" check.

import { App, Octokit } from "octokit";

import { logger } from "./logger.js";
import type {
  BugbotCheckResult,
  RepoRef,
  TrackedPullRequest,
} from "./types.js";

const BUGBOT_CHECK_NAME = "Cursor Bugbot";

export const ORIGINAL_MARKER_PREFIX = "<!-- PR_SHADOW_ORIGINAL:";
export const MANAGED_MARKER = "<!-- PR_SHADOW_MANAGED -->";

export class GitHubClient {
  private app: App;
  private userOctokit: Octokit;
  private installationMap: Map<string, number>;

  private constructor(app: App, userOctokit: Octokit) {
    this.app = app;
    this.userOctokit = userOctokit;
    this.installationMap = new Map();
  }

  static async create(
    appId: number,
    privateKey: string,
    githubToken: string
  ): Promise<GitHubClient> {
    const app = new App({ appId, privateKey });
    const userOctokit = new Octokit({ auth: githubToken });
    const client = new GitHubClient(app, userOctokit);
    await client.loadInstallations();
    return client;
  }

  private async loadInstallations(): Promise<void> {
    this.installationMap.clear();

    for await (const { installation } of this.app.eachInstallation.iterator()) {
      const login = installation.account?.login;
      if (login) {
        this.installationMap.set(login.toLowerCase(), installation.id);
        logger.info(
          `Found GitHub App installation for "${login}" (ID: ${installation.id}).`
        );
      }
    }

    if (this.installationMap.size === 0) {
      throw new Error(
        "No GitHub App installations found. Ensure the App is installed on at least one organization or user account."
      );
    }

    logger.info(
      `Loaded ${this.installationMap.size} GitHub App installation(s).`
    );
  }

  async listAccessibleRepos(): Promise<RepoRef[]> {
    await this.loadInstallations();

    const repos: RepoRef[] = [];

    for await (const { repository } of this.app.eachRepository.iterator()) {
      if (repository.archived) {
        continue;
      }
      repos.push({
        owner: repository.owner.login,
        name: repository.name,
      });
    }

    logger.info(
      `Found ${repos.length} accessible repository/repositories across all installations.`
    );
    return repos;
  }

  async listOpenPullRequests(
    owner: string,
    repo: string
  ): Promise<TrackedPullRequest[]> {
    logger.debug("Listing open pull requests.", { owner, repo });

    const results: TrackedPullRequest[] = [];

    for await (const response of this.userOctokit.paginate.iterator(
      this.userOctokit.rest.pulls.list,
      {
        owner,
        repo,
        state: "open",
        per_page: 100,
      }
    )) {
      for (const pr of response.data) {
        results.push(mapPullRequest(owner, repo, pr));
      }
    }

    logger.debug(`Found ${results.length} open PR(s).`, {
      owner,
      repo,
      count: results.length,
    });
    return results;
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<TrackedPullRequest | null> {
    logger.debug("Fetching PR details.", { owner, repo, prNumber });

    try {
      const { data: pr } = await this.userOctokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return mapPullRequest(owner, repo, pr);
    } catch (error) {
      if (isNotFound(error)) {
        logger.warn("PR not found.", { owner, repo, prNumber });
        return null;
      }
      throw wrapGithubError(
        "getPullRequest",
        { owner, repo, prNumber },
        error
      );
    }
  }

  async createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<TrackedPullRequest> {
    logger.info("Creating pull request.", {
      owner: params.owner,
      repo: params.repo,
      head: params.head,
      base: params.base,
      title: params.title,
    });

    try {
      const { data: pr } = await this.userOctokit.rest.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
      });
      return mapPullRequest(params.owner, params.repo, pr);
    } catch (error) {
      throw wrapGithubError("createPullRequest", params, error);
    }
  }

  async findPullRequestByHead(
    owner: string,
    repo: string,
    headBranch: string,
    state: "open" | "closed" | "all" = "all"
  ): Promise<TrackedPullRequest | null> {
    const head = `${owner}:${headBranch}`;
    logger.debug("Looking up PR by head branch.", {
      owner,
      repo,
      head,
      state,
    });

    try {
      const { data } = await this.userOctokit.rest.pulls.list({
        owner,
        repo,
        head,
        state,
        per_page: 10,
      });
      if (data.length === 0) {
        return null;
      }
      return mapPullRequest(owner, repo, data[0]);
    } catch (error) {
      throw wrapGithubError(
        "findPullRequestByHead",
        { owner, repo, headBranch, state },
        error
      );
    }
  }

  async updatePullRequest(params: {
    owner: string;
    repo: string;
    prNumber: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    base?: string;
  }): Promise<TrackedPullRequest> {
    logger.info("Updating pull request.", {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      state: params.state,
      base: params.base,
    });

    try {
      const { data: pr } = await this.userOctokit.rest.pulls.update({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
        title: params.title,
        body: params.body,
        state: params.state,
        base: params.base,
      });
      return mapPullRequest(params.owner, params.repo, pr);
    } catch (error) {
      throw wrapGithubError("updatePullRequest", params, error);
    }
  }

  async requestReviewers(params: {
    owner: string;
    repo: string;
    prNumber: number;
    reviewers: string[];
  }): Promise<void> {
    logger.info("Requesting PR reviewers.", {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      reviewers: params.reviewers,
    });

    try {
      await this.userOctokit.rest.pulls.requestReviewers({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
        reviewers: params.reviewers,
      });
    } catch (error) {
      throw wrapGithubError("requestReviewers", params, error);
    }
  }

  async createIssueComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<number> {
    logger.debug("Creating issue comment.", { owner, repo, prNumber });

    try {
      const { data } = await this.userOctokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      return data.id;
    } catch (error) {
      throw wrapGithubError(
        "createIssueComment",
        { owner, repo, prNumber },
        error
      );
    }
  }

  async hasIssueCommentContaining(
    owner: string,
    repo: string,
    prNumber: number,
    marker: string
  ): Promise<boolean> {
    logger.debug("Checking for existing issue comment with marker.", {
      owner,
      repo,
      prNumber,
      marker,
    });

    try {
      for await (const response of this.userOctokit.paginate.iterator(
        this.userOctokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
        }
      )) {
        for (const comment of response.data) {
          if (comment.body?.includes(marker)) {
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      throw wrapGithubError(
        "hasIssueCommentContaining",
        { owner, repo, prNumber, marker },
        error
      );
    }
  }

  async getCursorBugbotCheck(
    owner: string,
    repo: string,
    sha: string
  ): Promise<BugbotCheckResult> {
    logger.debug("Fetching Cursor Bugbot check for commit.", {
      owner,
      repo,
      sha,
    });

    try {
      const { data } = await this.userOctokit.rest.checks.listForRef({
        owner,
        repo,
        ref: sha,
        check_name: BUGBOT_CHECK_NAME,
        filter: "latest",
        per_page: 10,
      });

      const run = data.check_runs.find(
        (candidate) => candidate.name === BUGBOT_CHECK_NAME
      );

      if (!run) {
        return { status: "missing" };
      }
      if (run.status !== "completed") {
        return { status: "pending" };
      }
      if (run.conclusion === "success") {
        return { status: "success" };
      }
      return { status: "not_clean", conclusion: run.conclusion };
    } catch (error) {
      throw wrapGithubError(
        "getCursorBugbotCheck",
        { owner, repo, sha },
        error
      );
    }
  }
}

type GithubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  draft?: boolean;
  state: string;
  merged_at: string | null;
  base: { ref: string; repo: { full_name: string } };
  head: {
    ref: string;
    sha: string;
    repo: {
      name: string;
      full_name: string;
      owner: { login: string };
    } | null;
  };
};

function mapPullRequest(
  owner: string,
  repo: string,
  pr: GithubPull
): TrackedPullRequest {
  const headRepo = pr.head.repo;
  const repoFullName = `${owner}/${repo}`.toLowerCase();
  const isCrossRepo =
    !headRepo || headRepo.full_name.toLowerCase() !== repoFullName;

  const state = pr.state === "closed" ? "closed" : "open";

  return {
    owner,
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    htmlUrl: pr.html_url,
    authorLogin: pr.user?.login ?? "unknown",
    draft: pr.draft ?? false,
    state,
    merged: Boolean(pr.merged_at),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepoOwner: headRepo?.owner.login ?? owner,
    headRepoName: headRepo?.name ?? repo,
    isCrossRepo,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 404
  );
}

function wrapGithubError(
  functionName: string,
  params: Record<string, unknown>,
  error: unknown
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? String((error as { status: unknown }).status)
      : "unknown";
  return new Error(
    `${functionName} failed (status=${status}, params=${JSON.stringify(params)}): ${message}`
  );
}
