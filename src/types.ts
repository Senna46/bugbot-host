// Data models and type definitions for pr-shadow.
// Defines configuration, GitHub PR metadata, shadow tracking records,
// and Bugbot check results.
// Limitations: ShadowStatus values are stored in SQLite as strings
//   and must stay in sync with StateStore writes.

// ============================================================
// Configuration
// ============================================================

export interface Config {
  appId: number;
  privateKey: string;
  githubToken: string;
  authorLogin: string;
  pollInterval: number;
  workDir: string;
  dbPath: string;
  claudeModel: string | null;
  logLevel: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// ============================================================
// GitHub PR Data
// ============================================================

export interface TrackedPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  authorLogin: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepoOwner: string;
  headRepoName: string;
  isCrossRepo: boolean;
}

export interface RepoRef {
  owner: string;
  name: string;
}

// ============================================================
// Bugbot check on a commit
// ============================================================

export type BugbotCheckResult =
  | { status: "missing" }
  | { status: "pending" }
  | { status: "success" }
  | { status: "not_clean"; conclusion: string | null };

// ============================================================
// Shadow tracking
// ============================================================

export type ShadowStatus =
  | "mirroring"
  | "delivering"
  | "fork_notified"
  | "closed_no_changes"
  | "closed";

export interface ShadowRecord {
  repo: string;
  originalPr: number;
  shadowPr: number | null;
  shadowBranch: string;
  originalHeadSha: string | null;
  shadowHeadSha: string | null;
  originalAuthor: string;
  originalBaseRef: string;
  originalHeadRef: string;
  isCrossRepo: boolean;
  status: ShadowStatus;
  lastError: string | null;
  updatedAt: string;
}
