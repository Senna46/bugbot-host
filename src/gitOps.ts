// Local git operations for pr-shadow.
// Clones monitored repositories, fetches original PR heads via
// pull/{n}/head, maintains pr-shadow/{n} branches, and merges or
// cherry-picks original updates onto those branches.
// Uses SHADOW_GITHUB_TOKEN via http.extraheader so pushes trigger
// GitHub webhooks (needed for Cursor Bugbot).
// Limitations: Requires git CLI. Conflict resolution is delegated
//   to ConflictResolver. Single-threaded use per repo directory.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_USER_NAME = "pr-shadow";
const GIT_USER_EMAIL = "pr-shadow@users.noreply.github.com";

export class GitOps {
  private workDir: string;
  private githubToken: string;

  constructor(workDir: string, githubToken: string) {
    this.workDir = workDir;
    this.githubToken = githubToken;
  }

  repoDir(owner: string, repo: string): string {
    return join(this.workDir, owner, repo);
  }

  originalRefName(originalPr: number): string {
    return `refs/pr-shadow-original/${originalPr}`;
  }

  shadowBranchName(originalPr: number): string {
    return `pr-shadow/${originalPr}`;
  }

  async ensureRepoClone(owner: string, repo: string): Promise<string> {
    await mkdir(this.workDir, { recursive: true });
    const repoDir = this.repoDir(owner, repo);

    if (existsSync(join(repoDir, ".git"))) {
      logger.debug("Fetching latest for existing clone.", { repoDir });
      await this.execGit(repoDir, ["fetch", "--all", "--prune"]);
    } else {
      logger.info("Cloning repository.", { owner, repo, repoDir });
      await mkdir(join(this.workDir, owner), { recursive: true });
      const cloneUrl = `https://github.com/${owner}/${repo}.git`;
      await this.execGit(this.workDir, ["clone", cloneUrl, join(owner, repo)]);
    }

    return repoDir;
  }

  async fetchOriginalPullHead(
    repoDir: string,
    originalPr: number
  ): Promise<string> {
    const refName = this.originalRefName(originalPr);
    await this.execGit(repoDir, [
      "fetch",
      "origin",
      `pull/${originalPr}/head:${refName}`,
      "--force",
    ]);
    const sha = (await this.execGit(repoDir, ["rev-parse", refName])).trim();
    logger.debug("Fetched original PR head.", {
      repoDir,
      originalPr,
      sha: sha.substring(0, 10),
    });
    return sha;
  }

  async resetShadowBranchToSha(
    repoDir: string,
    branchName: string,
    sha: string
  ): Promise<void> {
    await this.discardLocalChanges(repoDir);
    await this.execGit(repoDir, ["checkout", "-B", branchName, sha]);
  }

  async checkoutShadowBranch(
    repoDir: string,
    branchName: string
  ): Promise<void> {
    await this.discardLocalChanges(repoDir);
    await this.execGit(repoDir, ["fetch", "origin", branchName]).catch(() => {
      logger.debug("Remote shadow branch not fetched yet.", {
        repoDir,
        branchName,
      });
    });

    try {
      await this.execGit(repoDir, ["checkout", branchName]);
      try {
        await this.execGit(repoDir, ["reset", "--hard", `origin/${branchName}`]);
      } catch {
        logger.debug("No origin tracking to reset against.", {
          repoDir,
          branchName,
        });
      }
    } catch {
      await this.execGit(repoDir, [
        "checkout",
        "-b",
        branchName,
        `origin/${branchName}`,
      ]);
    }
  }

  async currentHeadSha(repoDir: string): Promise<string> {
    return (await this.execGit(repoDir, ["rev-parse", "HEAD"])).trim();
  }

  async isAncestor(
    repoDir: string,
    ancestorSha: string,
    descendantSha: string
  ): Promise<boolean> {
    try {
      await this.execGit(repoDir, [
        "merge-base",
        "--is-ancestor",
        ancestorSha,
        descendantSha,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async listNonMergeCommits(
    repoDir: string,
    fromSha: string,
    toSha: string
  ): Promise<string[]> {
    const output = await this.execGit(repoDir, [
      "rev-list",
      "--reverse",
      "--no-merges",
      `${fromSha}..${toSha}`,
    ]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async mergeSha(
    repoDir: string,
    sha: string,
    message: string
  ): Promise<MergeResult> {
    try {
      await this.execGit(repoDir, [
        "-c",
        `user.name=${GIT_USER_NAME}`,
        "-c",
        `user.email=${GIT_USER_EMAIL}`,
        "merge",
        sha,
        "--no-edit",
        "-m",
        message,
      ]);
      return { status: "clean" };
    } catch (error) {
      const unmerged = await this.unmergedFiles(repoDir);
      if (unmerged.length > 0) {
        logger.warn("Merge produced conflicts.", {
          repoDir,
          sha: sha.substring(0, 10),
          unmerged,
        });
        return { status: "conflict", unmergedFiles: unmerged };
      }
      const messageText = error instanceof Error ? error.message : String(error);
      throw new Error(
        `mergeSha failed (repoDir=${repoDir}, sha=${sha.substring(0, 10)}): ${messageText}`
      );
    }
  }

  async cherryPick(repoDir: string, sha: string): Promise<MergeResult> {
    try {
      await this.execGit(repoDir, [
        "-c",
        `user.name=${GIT_USER_NAME}`,
        "-c",
        `user.email=${GIT_USER_EMAIL}`,
        "cherry-pick",
        sha,
      ]);
      return { status: "clean" };
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      if (/The previous cherry-pick is now empty|nothing to commit/i.test(stderr)) {
        await this.execGit(repoDir, ["cherry-pick", "--skip"]).catch(() => {
          // Already skipped or no in-progress cherry-pick.
        });
        return { status: "clean" };
      }

      const unmerged = await this.unmergedFiles(repoDir);
      if (unmerged.length > 0) {
        logger.warn("Cherry-pick produced conflicts.", {
          repoDir,
          sha: sha.substring(0, 10),
          unmerged,
        });
        return { status: "conflict", unmergedFiles: unmerged };
      }
      throw new Error(
        `cherryPick failed (repoDir=${repoDir}, sha=${sha.substring(0, 10)}): ${stderr}`
      );
    }
  }

  async finishConflictResolution(
    repoDir: string,
    mode: "merge" | "cherry-pick",
    message: string
  ): Promise<void> {
    const remaining = await this.filesWithConflictMarkers(repoDir);
    if (remaining.length > 0) {
      throw new Error(
        `finishConflictResolution failed (repoDir=${repoDir}, mode=${mode}): conflict markers remain in ${remaining.join(", ")}`
      );
    }

    const stillUnmerged = await this.unmergedFiles(repoDir);
    if (stillUnmerged.length > 0) {
      await this.execGit(repoDir, ["add", "-A"]);
    } else {
      await this.execGit(repoDir, ["add", "-A"]);
    }

    if (mode === "cherry-pick") {
      await this.execGit(repoDir, [
        "-c",
        `user.name=${GIT_USER_NAME}`,
        "-c",
        `user.email=${GIT_USER_EMAIL}`,
        "-c",
        "core.editor=true",
        "cherry-pick",
        "--continue",
      ]);
      return;
    }

    await this.execGit(repoDir, [
      "-c",
      `user.name=${GIT_USER_NAME}`,
      "-c",
      `user.email=${GIT_USER_EMAIL}`,
      "commit",
      "--no-edit",
      "-m",
      message,
    ]);
  }

  async abortInProgress(repoDir: string): Promise<void> {
    await this.execGit(repoDir, ["merge", "--abort"]).catch(() => undefined);
    await this.execGit(repoDir, ["cherry-pick", "--abort"]).catch(
      () => undefined
    );
    await this.discardLocalChanges(repoDir);
  }

  async hasFileDiff(
    repoDir: string,
    shaA: string,
    shaB: string
  ): Promise<boolean> {
    const output = await this.execGit(repoDir, [
      "diff",
      "--name-only",
      shaA,
      shaB,
    ]);
    return output.trim().length > 0;
  }

  async pushBranch(repoDir: string, branchName: string): Promise<void> {
    await this.execGit(repoDir, ["push", "-u", "--force", "origin", branchName]);
  }

  async unmergedFiles(repoDir: string): Promise<string[]> {
    const output = await this.execGit(repoDir, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async filesWithConflictMarkers(repoDir: string): Promise<string[]> {
    const { readFile } = await import("fs/promises");
    const candidates = await this.unmergedFiles(repoDir);
    const status = await this.execGit(repoDir, [
      "diff",
      "--name-only",
      "HEAD",
    ]).catch(async () => {
      return this.execGit(repoDir, ["status", "--porcelain"]);
    });
    const extra = status
      .split("\n")
      .map((line) => line.trim().replace(/^..\s+/, ""))
      .filter((line) => line.length > 0);
    const all = [...new Set([...candidates, ...extra])];
    const marked: string[] = [];

    for (const relativePath of all) {
      try {
        const content = await readFile(join(repoDir, relativePath), "utf-8");
        if (content.includes("<<<<<<<") || content.includes(">>>>>>>")) {
          marked.push(relativePath);
        }
      } catch {
        // Binary or missing file.
      }
    }

    return marked;
  }

  private async discardLocalChanges(repoDir: string): Promise<void> {
    await this.execGit(repoDir, ["reset", "--hard", "HEAD"]).catch(() => {
      // Empty repo or no HEAD yet.
    });
    await this.execGit(repoDir, ["clean", "-fd"]);
  }

  private buildGitAuthArgs(): string[] {
    const encoded = Buffer.from(
      `x-access-token:${this.githubToken}`
    ).toString("base64");
    return [
      "-c",
      `http.https://github.com/.extraheader=Authorization: basic ${encoded}`,
    ];
  }

  private async execGit(cwd: string, args: string[]): Promise<string> {
    logger.debug(`git ${args.join(" ")}`, { cwd });
    const fullArgs = [...this.buildGitAuthArgs(), ...args];
    try {
      const { stdout } = await execFileAsync("git", fullArgs, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout;
    } catch (error) {
      const execError = error as {
        message?: string;
        stderr?: string;
        stdout?: string;
        code?: number | string;
      };
      logger.error(`git ${args.join(" ")} failed.`, {
        cwd,
        exitCode: execError.code,
        stderr: sanitizeGitError(execError.stderr?.trim() || "(empty)"),
        stdout: sanitizeGitError(execError.stdout?.trim() || "(empty)"),
      });
      if (execError.stderr) {
        execError.stderr = sanitizeGitError(execError.stderr);
      }
      if (execError.stdout) {
        execError.stdout = sanitizeGitError(execError.stdout);
      }
      if (execError.message) {
        execError.message = sanitizeGitError(execError.message);
      }
      throw error;
    }
  }
}

export type MergeResult =
  | { status: "clean" }
  | { status: "conflict"; unmergedFiles: string[] };

export function sanitizeGitError(message: string): string {
  return message
    .replace(/x-access-token:[^\s@]+/g, "x-access-token:[REDACTED]")
    .replace(
      /http\.[^\s]*\.extraheader=Authorization: basic [A-Za-z0-9+/=]+/g,
      "http.extraheader=[REDACTED]"
    )
    .replace(
      /Authorization: basic [A-Za-z0-9+/=]+/g,
      "Authorization: basic [REDACTED]"
    );
}
