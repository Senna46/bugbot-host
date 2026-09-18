// Main entry point for the pr-shadow daemon.
// Polls GitHub App installations for open PRs authored by other people,
// creates Senna46-authored mirror PRs for Cursor Bugbot, syncs later
// original commits, and delivers Fixooly results back to the original PR.
// Limitations: Single-threaded; processes repositories sequentially
//   within each polling cycle. Graceful shutdown on SIGINT/SIGTERM.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { loadConfig } from "./config.js";
import { ConflictResolver } from "./conflictResolver.js";
import { GitHubClient } from "./githubClient.js";
import { GitOps } from "./gitOps.js";
import { logger, setLogLevel } from "./logger.js";
import { shouldMirrorPullRequest } from "./prMonitor.js";
import { ShadowManager } from "./shadowManager.js";
import { StateStore } from "./state.js";
import type { Config } from "./types.js";

class PrShadowDaemon {
  private config: Config;
  private state: StateStore;
  private github!: GitHubClient;
  private manager!: ShadowManager;
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dbPath);
  }

  async initialize(): Promise<void> {
    logger.info("Initializing pr-shadow...");
    logger.info("Configuration loaded.", {
      appId: this.config.appId,
      authorLogin: this.config.authorLogin,
      pollInterval: this.config.pollInterval,
      claudeModel: this.config.claudeModel ?? "(default)",
    });

    await this.verifyPrerequisites();

    const minPrCreatedAt = this.state.ensureMinPrCreatedAt(
      this.config.minPrCreatedAt
    );
    this.config.minPrCreatedAt = minPrCreatedAt;
    logger.info("Only mirroring PRs created at or after cutoff.", {
      minPrCreatedAt,
    });

    this.github = await GitHubClient.create(
      this.config.appId,
      this.config.privateKey,
      this.config.githubToken
    );
    const gitOps = new GitOps(this.config.workDir, this.config.githubToken);
    const conflicts = new ConflictResolver(this.config, gitOps);
    this.manager = new ShadowManager(
      this.config,
      this.github,
      this.state,
      gitOps,
      conflicts
    );

    logger.info("Initialization complete. Starting daemon loop.");
  }

  private async verifyPrerequisites(): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    if (!this.config.appId || !this.config.privateKey) {
      throw new Error(
        "GitHub App credentials are missing. Set SHADOW_APP_ID and " +
          "SHADOW_PRIVATE_KEY_PATH (or SHADOW_PRIVATE_KEY)."
      );
    }
    if (!this.config.githubToken) {
      throw new Error(
        "SHADOW_GITHUB_TOKEN is missing. A Senna46 classic PAT is required so mirror PRs are user-authored."
      );
    }

    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      logger.debug("claude CLI version.", { version: stdout.trim() });
    } catch {
      throw new Error(
        "claude CLI is not available. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }

    if (
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      const { existsSync } = await import("fs");
      const homeDir = process.env.HOME ?? "/root";
      const credFile = `${homeDir}/.claude/.credentials.json`;
      if (!existsSync(credFile)) {
        logger.warn(
          "No Claude authentication detected. " +
            "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, " +
            "or ensure ~/.claude/.credentials.json exists."
        );
      }
    }

    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      throw new Error("git is not available. Install git first.");
    }
  }

  async run(): Promise<void> {
    this.registerShutdownHandlers();

    while (!this.isShuttingDown) {
      try {
        await this.pollCycle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error in polling cycle.", { error: message });
      }

      if (!this.isShuttingDown) {
        logger.info(
          `Sleeping for ${this.config.pollInterval}s before next cycle...`
        );
        await this.sleep(this.config.pollInterval * 1000);
      }
    }

    this.shutdown();
  }

  private async pollCycle(): Promise<void> {
    logger.info("Starting polling cycle...");

    const repos = await this.github.listAccessibleRepos();
    logger.info(`Scanning ${repos.length} repo(s) for PRs to mirror.`);

    for (const repo of repos) {
      if (this.isShuttingDown) {
        break;
      }
      try {
        await this.processRepository(repo.owner, repo.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error processing repository ${repo.owner}/${repo.name}.`, {
          error: message,
          owner: repo.owner,
          repo: repo.name,
        });
      }
    }
  }

  private async processRepository(owner: string, repo: string): Promise<void> {
    const repoName = `${owner}/${repo}`;
    const minPrCreatedAt = this.config.minPrCreatedAt;
    if (!minPrCreatedAt) {
      throw new Error(
        `processRepository failed: minPrCreatedAt is not set (owner=${owner}, repo=${repo}).`
      );
    }

    const openPrs = await this.github.listOpenPullRequests(
      owner,
      repo,
      minPrCreatedAt
    );
    const originals = openPrs.filter((pr) =>
      shouldMirrorPullRequest(pr, this.config.authorLogin, minPrCreatedAt)
    );
    const tracked = this.state.listForRepo(repoName);
    const originalNumbers = new Set(originals.map((pr) => pr.number));

    logger.debug("Repository scan.", {
      repo: repoName,
      openPrCount: openPrs.length,
      eligibleCount: originals.length,
      trackedCount: tracked.length,
    });

    for (const original of originals) {
      if (this.isShuttingDown) {
        break;
      }
      const record = this.state.get(repoName, original.number);
      try {
        await this.manager.processOriginal(original, record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error processing original PR.", {
          error: message,
          repo: repoName,
          originalPr: original.number,
        });
      }
    }

    for (const record of tracked) {
      if (this.isShuttingDown) {
        break;
      }
      if (originalNumbers.has(record.originalPr)) {
        continue;
      }
      if (record.status === "closed") {
        continue;
      }
      try {
        await this.manager.processOrphanRecord(owner, repo, record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error processing tracked shadow without an open original.", {
          error: message,
          repo: repoName,
          originalPr: record.originalPr,
        });
      }
    }
  }

  private registerShutdownHandlers(): void {
    const handleShutdown = (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      this.isShuttingDown = true;
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private shutdown(): void {
    this.state.close();
    logger.info("pr-shadow stopped.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const checkShutdown = setInterval(() => {
        if (this.isShuttingDown) {
          clearTimeout(timer);
          clearInterval(checkShutdown);
          resolve();
        }
      }, 1000);
      const timer = setTimeout(() => {
        clearInterval(checkShutdown);
        resolve();
      }, ms);
    });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(dbPath: string): string {
  const lockPath = join(dirname(dbPath), "daemon.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existingPid = readFileSync(lockPath, "utf-8").trim();
      const pid = parseInt(existingPid, 10);

      if (!isNaN(pid) && pid !== process.pid && isProcessRunning(pid)) {
        throw new Error(
          `Another daemon instance is already running (PID ${existingPid}, lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }

      try {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
      } catch {
        throw new Error(
          `Another daemon instance is already running (lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }
      return lockPath;
    }
    throw error;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup
  }
}

async function main(): Promise<void> {
  let lockPath: string | null = null;
  try {
    const config = loadConfig();
    setLogLevel(config.logLevel);

    mkdirSync(dirname(config.dbPath), { recursive: true });
    lockPath = acquireLock(config.dbPath);

    const daemon = new PrShadowDaemon(config);
    await daemon.initialize();
    await daemon.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    if (lockPath) releaseLock(lockPath);
    process.exit(1);
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

main();
