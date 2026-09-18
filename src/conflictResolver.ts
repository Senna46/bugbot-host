// Merge-conflict resolution for bugbot-host using claude -p.
// After a git merge or cherry-pick stops with unmerged files, Claude
// edits the working tree to remove conflict markers. This module does
// not run git add/commit; GitOps finishes the git operation.
// Limitations: 10-minute timeout. Claude may fail to resolve some
//   conflicts; the caller must abort, comment, and retry later.

import { spawn } from "child_process";

import { logger } from "./logger.js";
import type { GitOps } from "./gitOps.js";
import type { Config } from "./types.js";

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git log *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(rg *)",
  "Bash(grep *)",
].join(",");

const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_STDOUT_SIZE = 100_000;

export class ConflictResolver {
  private config: Config;
  private gitOps: GitOps;

  constructor(config: Config, gitOps: GitOps) {
    this.config = config;
    this.gitOps = gitOps;
  }

  async resolve(
    repoDir: string,
    unmergedFiles: string[],
    context: {
      owner: string;
      repo: string;
      originalPr: number;
      mode: "merge" | "cherry-pick";
    }
  ): Promise<boolean> {
    logger.info("Running claude -p to resolve merge conflicts.", {
      repoDir,
      owner: context.owner,
      repo: context.repo,
      originalPr: context.originalPr,
      mode: context.mode,
      unmergedFiles,
    });

    const prompt = this.buildPrompt(unmergedFiles, context);

    try {
      await this.runClaude(repoDir, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("claude -p conflict resolution failed.", {
        error: message,
        repoDir,
        originalPr: context.originalPr,
        mode: context.mode,
      });
      return false;
    }

    const remaining = await this.gitOps.filesWithConflictMarkers(repoDir);
    if (remaining.length > 0) {
      logger.error("Conflict markers remain after claude -p.", {
        repoDir,
        remaining,
        originalPr: context.originalPr,
      });
      return false;
    }

    return true;
  }

  private buildPrompt(
    unmergedFiles: string[],
    context: {
      owner: string;
      repo: string;
      originalPr: number;
      mode: "merge" | "cherry-pick";
    }
  ): string {
    const fileList = unmergedFiles.map((path) => `- ${path}`).join("\n");

    return [
      "You are resolving git conflicts in this repository.",
      "",
      `Repository: ${context.owner}/${context.repo}`,
      `Original pull request: #${context.originalPr}`,
      `Git operation: ${context.mode}`,
      "",
      "A bugbot-host branch already contains extra commits (usually Fixooly bug fixes).",
      "New commits from the original pull request are being applied onto that branch.",
      "",
      "Unmerged files:",
      fileList,
      "",
      "Conflicted files contain standard git conflict markers (<<<<<<<, =======, >>>>>>>).",
      "",
      "Rules:",
      "- Resolve every conflict by editing files with the Edit tool.",
      "- Keep both the original PR's new work and the extra shadow/Fixooly fixes when they do not contradict.",
      "- If they contradict, keep the original PR behavior and still apply the bug-fix intent if possible.",
      "- Do not create new files unless a conflict made that necessary.",
      "- Do not run git commit, git add, git merge, or git cherry-pick. Only edit files.",
      "- After resolving, there must be no conflict markers left.",
      "",
      "When done, print exactly one of:",
      "RESOLVE_STATUS: success",
      "RESOLVE_STATUS: failed | <reason>",
    ].join("\n");
  }

  private async runClaude(repoDir: string, prompt: string): Promise<string> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];
    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const child = spawn("claude", args, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const killTimer = setTimeout(() => {
        if (settled) return;
        logger.warn("claude -p timed out, sending SIGTERM.", {
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          logger.warn("claude -p did not exit after SIGTERM, sending SIGKILL.");
          child.kill("SIGKILL");
        }, SIGKILL_GRACE_MS);
      }, CLAUDE_TIMEOUT_MS);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_STDOUT_SIZE) {
          stdout = stdout.substring(stdout.length - MAX_STDOUT_SIZE);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code, signal) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(
            new Error(
              `claude -p conflict resolution timed out after ${CLAUDE_TIMEOUT_MS / 1000}s (repoDir=${repoDir}).`
            )
          );
          return;
        }
        if (code !== 0) {
          logger.error("claude -p exited with non-zero code.", {
            exitCode: code,
            stderr: stderr.substring(0, 1000) || "(empty)",
            stdoutTail:
              stdout.substring(Math.max(0, stdout.length - 2000)) || "(empty)",
          });
          reject(
            new Error(
              `claude -p conflict resolution exited with code ${code} (repoDir=${repoDir}).`
            )
          );
          return;
        }
        resolve(stdout);
      });

      child.on("error", (error) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `claude -p conflict resolution failed to start (repoDir=${repoDir}): ${error.message}`
          )
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
