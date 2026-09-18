// Discovers open pull requests that should be mirrored for Bugbot.
// A PR is eligible when it is open, not a draft, not authored by
// SHADOW_AUTHOR_LOGIN, not a bot, and not already a pr-shadow mirror.
// Limitations: Draft PRs are skipped until marked ready. Bot detection
//   is login-based (`[bot]` suffix) and may miss unusual bot accounts.

import {
  MANAGED_MARKER,
  ORIGINAL_MARKER_PREFIX,
} from "./githubClient.js";
import type { TrackedPullRequest } from "./types.js";

export function shouldMirrorPullRequest(
  pr: TrackedPullRequest,
  authorLogin: string
): boolean {
  if (pr.state !== "open") {
    return false;
  }
  if (pr.draft) {
    return false;
  }
  if (pr.authorLogin.toLowerCase() === authorLogin.toLowerCase()) {
    return false;
  }
  if (isBotLogin(pr.authorLogin)) {
    return false;
  }
  if (pr.headRef.startsWith("pr-shadow/")) {
    return false;
  }
  if (pr.body.includes(ORIGINAL_MARKER_PREFIX) || pr.body.includes(MANAGED_MARKER)) {
    return false;
  }
  return true;
}

export function isBotLogin(login: string): boolean {
  const lower = login.toLowerCase();
  return lower.endsWith("[bot]") || lower === "dependabot" || lower === "renovate";
}

export function buildShadowBranchName(originalPr: number): string {
  return `pr-shadow/${originalPr}`;
}

export function buildOriginalMarker(owner: string, repo: string, originalPr: number): string {
  return `${ORIGINAL_MARKER_PREFIX} ${owner}/${repo}#${originalPr} -->`;
}
