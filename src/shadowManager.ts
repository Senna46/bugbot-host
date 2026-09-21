// Orchestrates hosted PR lifecycle for bugbot-host.
// Creates Senna46-authored shadow PRs, keeps them in sync with original
// PR heads, waits for the Cursor Bugbot check to succeed, then retargets,
// notifies, or closes according to same-repo vs fork and whether extra
// commits exist.
// Limitations: Does not merge shadow PRs into a default branch. Fork
//   PRs are never retargeted. Conflict resolution depends on claude -p.
//   delivering / no_changes / fork_fixes comments are posted at most once
//   per original PR; later retargets skip the comment.

import { ConflictResolver } from "./conflictResolver.js";
import {
  GitHubClient,
  MANAGED_MARKER,
} from "./githubClient.js";
import { GitOps } from "./gitOps.js";
import { logger } from "./logger.js";
import {
  buildLegacyShadowBranchName,
  buildOriginalMarker,
  buildShadowBranchName,
  isCreatedBeforeCutoff,
} from "./prMonitor.js";
import type { StateStore } from "./state.js";
import type {
  Config,
  ShadowRecord,
  ShadowStatus,
  TrackedPullRequest,
} from "./types.js";

// Complete HTML comments. GitHub hides them; never append text after "-->"
// (that would leak as visible ":sha" on the original PR).
const COMMENT_NO_CHANGES = "<!-- BUGBOT_HOST_COMMENT: no_changes -->";
const COMMENT_FORK_FIXES = "<!-- BUGBOT_HOST_COMMENT: fork_fixes -->";
const COMMENT_DELIVERING = "<!-- BUGBOT_HOST_COMMENT: delivering -->";
const COMMENT_ORIGINAL_CLOSED = "<!-- BUGBOT_HOST_COMMENT: original_closed -->";
const COMMENT_TOO_OLD = "<!-- BUGBOT_HOST_COMMENT: too_old -->";

export class ShadowManager {
  private config: Config;
  private github: GitHubClient;
  private state: StateStore;
  private gitOps: GitOps;
  private conflicts: ConflictResolver;

  constructor(
    config: Config,
    github: GitHubClient,
    state: StateStore,
    gitOps: GitOps,
    conflicts: ConflictResolver
  ) {
    this.config = config;
    this.github = github;
    this.state = state;
    this.gitOps = gitOps;
    this.conflicts = conflicts;
  }

  async processOriginal(
    original: TrackedPullRequest,
    record: ShadowRecord | null
  ): Promise<void> {
    const repo = repoFullName(original);
    const minPrCreatedAt = this.requireMinPrCreatedAt();

    if (isCreatedBeforeCutoff(original, minPrCreatedAt)) {
      if (!record || record.status === "closed") {
        logger.debug("Skipping historical open PR created before cutoff.", {
          repo,
          originalPr: original.number,
          createdAt: original.createdAt,
          minPrCreatedAt,
        });
        return;
      }
      await this.closeBecauseTooOld(original, record, minPrCreatedAt);
      return;
    }

    if (!record) {
      const reused = await this.adoptExistingShadow(original);
      if (reused) {
        await this.processOriginal(original, reused);
        return;
      }
      await this.createShadow(original);
      return;
    }

    if (original.state === "closed" || original.merged) {
      await this.closeBecauseOriginalDone(original, record);
      return;
    }

    if (record.status === "closed") {
      logger.debug("Skipping closed mapping for still-open original PR.", {
        repo,
        originalPr: original.number,
      });
      return;
    }

    if (
      record.status === "delivering" ||
      record.status === "fork_notified" ||
      record.status === "closed_no_changes"
    ) {
      if (record.originalHeadSha === original.headSha) {
        logger.debug("Shadow already delivered and original SHA is unchanged.", {
          repo,
          originalPr: original.number,
          status: record.status,
        });
        return;
      }
      await this.returnToMirroring(original, record);
    }

    const latest = this.state.get(repo, original.number) ?? record;
    if (latest.status !== "mirroring") {
      return;
    }

    const syncResult = await this.syncOriginalIntoShadow(original, latest);
    if (syncResult === "conflict") {
      return;
    }

    const afterSync = this.state.get(repo, original.number) ?? latest;
    await this.maybeCompleteMirroring(original, afterSync);
  }

  async processOrphanRecord(
    owner: string,
    repo: string,
    record: ShadowRecord
  ): Promise<void> {
    const original = await this.github.getPullRequest(
      owner,
      repo,
      record.originalPr
    );
    if (!original || original.state === "closed" || original.merged) {
      await this.closeBecauseOriginalDone(original, record);
      return;
    }

    const minPrCreatedAt = this.requireMinPrCreatedAt();
    if (isCreatedBeforeCutoff(original, minPrCreatedAt)) {
      await this.closeBecauseTooOld(original, record, minPrCreatedAt);
      return;
    }

    await this.processOriginal(original, record);
  }

  // ============================================================
  // Create a new shadow branch and PR
  // ============================================================

  private async adoptExistingShadow(
    original: TrackedPullRequest
  ): Promise<ShadowRecord | null> {
    const preferredBranch = buildShadowBranchName(original.number);
    const legacyBranch = buildLegacyShadowBranchName(original.number);

    for (const branchName of [preferredBranch, legacyBranch]) {
      const existing = await this.github.findPullRequestByHead(
        original.owner,
        original.repo,
        branchName,
        "all"
      );
      if (!existing) {
        continue;
      }

      logger.info("Adopting existing hosted PR instead of creating a new one.", {
        repo: repoFullName(original),
        originalPr: original.number,
        shadowPr: existing.number,
        shadowBranch: branchName,
      });

      const record = buildRecord(original, {
        shadowPr: existing.number,
        shadowBranch: branchName,
        originalHeadSha: original.headSha,
        shadowHeadSha: existing.headSha,
        status: inferAdoptedShadowStatus(existing, original),
        lastError: null,
      });
      this.state.upsert(record);
      return record;
    }

    return null;
  }

  private async createShadow(original: TrackedPullRequest): Promise<void> {
    const repo = repoFullName(original);
    const branchName = buildShadowBranchName(original.number);

    logger.info("Creating shadow PR.", {
      repo,
      originalPr: original.number,
      branchName,
      originalSha: original.headSha.substring(0, 10),
    });

    const repoDir = await this.gitOps.ensureRepoClone(
      original.owner,
      original.repo
    );
    const originalSha = await this.gitOps.fetchOriginalPullHead(
      repoDir,
      original.number
    );
    await this.gitOps.resetShadowBranchToSha(repoDir, branchName, originalSha);
    await this.gitOps.pushBranch(repoDir, branchName);

    const shadowPr = await this.ensureShadowPullRequest(original, branchName);

    this.state.upsert(
      buildRecord(original, {
        shadowPr: shadowPr.number,
        shadowBranch: branchName,
        originalHeadSha: originalSha,
        shadowHeadSha: originalSha,
        status: "mirroring",
        lastError: null,
      })
    );

    logger.info("Shadow PR created.", {
      repo,
      originalPr: original.number,
      shadowPr: shadowPr.number,
      shadowUrl: shadowPr.htmlUrl,
    });
  }

  private async ensureShadowPullRequest(
    original: TrackedPullRequest,
    branchName: string
  ): Promise<TrackedPullRequest> {
    const existing = await this.github.findPullRequestByHead(
      original.owner,
      original.repo,
      branchName,
      "all"
    );

    if (existing) {
      if (existing.state === "closed") {
        return this.github.updatePullRequest({
          owner: original.owner,
          repo: original.repo,
          prNumber: existing.number,
          state: "open",
          base: original.baseRef,
          title: buildShadowTitle(original),
          body: buildShadowBody(original, this.config.authorLogin),
        });
      }
      if (existing.baseRef !== original.baseRef) {
        return this.github.updatePullRequest({
          owner: original.owner,
          repo: original.repo,
          prNumber: existing.number,
          base: original.baseRef,
          title: buildShadowTitle(original),
          body: buildShadowBody(original, this.config.authorLogin),
        });
      }
      return existing;
    }

    return this.github.createPullRequest({
      owner: original.owner,
      repo: original.repo,
      title: buildShadowTitle(original),
      head: branchName,
      base: original.baseRef,
      body: buildShadowBody(original, this.config.authorLogin),
    });
  }

  // ============================================================
  // Return a delivered/closed shadow back to mirroring
  // ============================================================

  private async returnToMirroring(
    original: TrackedPullRequest,
    record: ShadowRecord
  ): Promise<void> {
    logger.info("Original PR moved after delivery. Returning to mirroring.", {
      repo: repoFullName(original),
      originalPr: original.number,
      previousStatus: record.status,
      previousSha: record.originalHeadSha,
      newSha: original.headSha.substring(0, 10),
    });

    const shadowPr = await this.ensureShadowPullRequest(
      original,
      record.shadowBranch
    );

    this.state.upsert({
      ...record,
      shadowPr: shadowPr.number,
      originalBaseRef: original.baseRef,
      originalHeadRef: original.headRef,
      isCrossRepo: original.isCrossRepo,
      originalAuthor: original.authorLogin,
      status: "mirroring",
      lastError: null,
      updatedAt: nowIso(),
    });
  }

  // ============================================================
  // Sync original commits onto the shadow branch
  // ============================================================

  private async syncOriginalIntoShadow(
    original: TrackedPullRequest,
    record: ShadowRecord
  ): Promise<"unchanged" | "synced" | "conflict"> {
    const repoDir = await this.gitOps.ensureRepoClone(
      original.owner,
      original.repo
    );
    const originalSha = await this.gitOps.fetchOriginalPullHead(
      repoDir,
      original.number
    );
    await this.gitOps.checkoutShadowBranch(repoDir, record.shadowBranch);
    const shadowHead = await this.gitOps.currentHeadSha(repoDir);

    const alreadyContainsOriginal = await this.gitOps.isAncestor(
      repoDir,
      originalSha,
      shadowHead
    );
    if (
      alreadyContainsOriginal &&
      record.originalHeadSha === originalSha
    ) {
      this.state.upsert({
        ...record,
        shadowHeadSha: shadowHead,
        lastError: null,
        updatedAt: nowIso(),
      });
      return "unchanged";
    }

    if (alreadyContainsOriginal) {
      this.state.upsert({
        ...record,
        originalHeadSha: originalSha,
        shadowHeadSha: shadowHead,
        lastError: null,
        updatedAt: nowIso(),
      });
      return "unchanged";
    }

    const lastSynced = record.originalHeadSha;
    const originalFastForwarded =
      lastSynced !== null &&
      (await this.gitOps.isAncestor(repoDir, lastSynced, originalSha));

    try {
      if (originalFastForwarded) {
        const merged = await this.mergeWithConflictHandling(
          repoDir,
          original,
          originalSha,
          `Merge original PR #${original.number} into ${record.shadowBranch}`
        );
        if (!merged) {
          return "conflict";
        }
      } else {
        const uniqueCommits =
          lastSynced === null
            ? []
            : await this.gitOps.listNonMergeCommits(
                repoDir,
                lastSynced,
                shadowHead
              );
        await this.gitOps.resetShadowBranchToSha(
          repoDir,
          record.shadowBranch,
          originalSha
        );
        for (const commitSha of uniqueCommits) {
          const cherry = await this.cherryPickWithConflictHandling(
            repoDir,
            original,
            commitSha
          );
          if (!cherry) {
            return "conflict";
          }
        }
      }

      await this.gitOps.pushBranch(repoDir, record.shadowBranch);
      const newShadowHead = await this.gitOps.currentHeadSha(repoDir);
      this.state.upsert({
        ...record,
        originalHeadSha: originalSha,
        shadowHeadSha: newShadowHead,
        originalBaseRef: original.baseRef,
        originalHeadRef: original.headRef,
        isCrossRepo: original.isCrossRepo,
        lastError: null,
        updatedAt: nowIso(),
      });
      logger.info("Synced original PR commits into shadow branch.", {
        repo: repoFullName(original),
        originalPr: original.number,
        originalSha: originalSha.substring(0, 10),
        shadowHeadSha: newShadowHead.substring(0, 10),
      });
      return "synced";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to sync original PR into shadow branch.", {
        error: message,
        repo: repoFullName(original),
        originalPr: original.number,
      });
      await this.gitOps.abortInProgress(repoDir);
      this.state.upsert({
        ...record,
        lastError: message,
        updatedAt: nowIso(),
      });
      throw error;
    }
  }

  private async mergeWithConflictHandling(
    repoDir: string,
    original: TrackedPullRequest,
    originalSha: string,
    message: string
  ): Promise<boolean> {
    const result = await this.gitOps.mergeSha(repoDir, originalSha, message);
    if (result.status === "clean") {
      return true;
    }
    return this.resolveAndFinish(
      repoDir,
      original,
      result.unmergedFiles,
      "merge",
      message
    );
  }

  private async cherryPickWithConflictHandling(
    repoDir: string,
    original: TrackedPullRequest,
    commitSha: string
  ): Promise<boolean> {
    const result = await this.gitOps.cherryPick(repoDir, commitSha);
    if (result.status === "clean") {
      return true;
    }
    return this.resolveAndFinish(
      repoDir,
      original,
      result.unmergedFiles,
      "cherry-pick",
      `Cherry-pick ${commitSha.substring(0, 10)} onto bugbot-host/${original.number}`
    );
  }

  private async resolveAndFinish(
    repoDir: string,
    original: TrackedPullRequest,
    unmergedFiles: string[],
    mode: "merge" | "cherry-pick",
    message: string
  ): Promise<boolean> {
    const resolved = await this.conflicts.resolve(repoDir, unmergedFiles, {
      owner: original.owner,
      repo: original.repo,
      originalPr: original.number,
      mode,
    });
    if (!resolved) {
      await this.gitOps.abortInProgress(repoDir);
      await this.commentConflictFailure(original, unmergedFiles, mode);
      const existing = this.state.get(repoFullName(original), original.number);
      if (existing) {
        this.state.upsert({
          ...existing,
          lastError: `Failed to resolve ${mode} conflicts for original PR #${original.number}`,
          updatedAt: nowIso(),
        });
      }
      return false;
    }

    await this.gitOps.finishConflictResolution(repoDir, mode, message);
    return true;
  }

  // ============================================================
  // Complete mirroring once Bugbot is green
  // ============================================================

  private async maybeCompleteMirroring(
    original: TrackedPullRequest,
    record: ShadowRecord
  ): Promise<void> {
    if (record.shadowPr === null) {
      logger.warn("Cannot complete mirroring without a shadow PR number.", {
        repo: repoFullName(original),
        originalPr: original.number,
      });
      return;
    }

    const shadowPr = await this.github.getPullRequest(
      original.owner,
      original.repo,
      record.shadowPr
    );
    if (!shadowPr || shadowPr.state !== "open") {
      logger.warn("Shadow PR is missing or not open; recreating.", {
        repo: repoFullName(original),
        originalPr: original.number,
        shadowPr: record.shadowPr,
      });
      await this.returnToMirroring(original, record);
      return;
    }

    if (shadowPr.baseRef !== original.baseRef) {
      await this.github.updatePullRequest({
        owner: original.owner,
        repo: original.repo,
        prNumber: shadowPr.number,
        base: original.baseRef,
      });
    }

    const bugbot = await this.github.getCursorBugbotCheck(
      original.owner,
      original.repo,
      shadowPr.headSha
    );
    if (bugbot.status !== "success") {
      logger.info("Waiting for Cursor Bugbot success on shadow PR.", {
        repo: repoFullName(original),
        originalPr: original.number,
        shadowPr: shadowPr.number,
        shadowSha: shadowPr.headSha.substring(0, 10),
        bugbot,
      });
      return;
    }

    const repoDir = await this.gitOps.ensureRepoClone(
      original.owner,
      original.repo
    );
    await this.gitOps.fetchOriginalPullHead(repoDir, original.number);
    await this.gitOps.checkoutShadowBranch(repoDir, record.shadowBranch);
    const shadowHead = await this.gitOps.currentHeadSha(repoDir);
    const containsOriginal = await this.gitOps.isAncestor(
      repoDir,
      original.headSha,
      shadowHead
    );
    if (!containsOriginal) {
      logger.info("Shadow branch does not yet contain original HEAD.", {
        repo: repoFullName(original),
        originalPr: original.number,
        originalSha: original.headSha.substring(0, 10),
        shadowHead: shadowHead.substring(0, 10),
      });
      return;
    }

    const hasExtraChanges = await this.gitOps.hasFileDiff(
      repoDir,
      original.headSha,
      shadowHead
    );
    if (!hasExtraChanges) {
      await this.closeNoChanges(original, record, shadowPr);
      return;
    }
    if (original.isCrossRepo) {
      await this.notifyFork(original, record, shadowPr);
      return;
    }
    await this.deliverSameRepo(original, record, shadowPr);
  }

  private async closeNoChanges(
    original: TrackedPullRequest,
    record: ShadowRecord,
    shadowPr: TrackedPullRequest
  ): Promise<void> {
    logger.info("Bugbot is clean and shadow has no extra diff. Closing shadow PR.", {
      repo: repoFullName(original),
      originalPr: original.number,
      shadowPr: shadowPr.number,
    });

    await this.commentOnce(
      original.owner,
      original.repo,
      original.number,
      COMMENT_NO_CHANGES,
      buildHostComment(COMMENT_NO_CHANGES, [
        `[bugbot-host](https://github.com/Senna46/bugbot-host) mirrored this PR as #${shadowPr.number} so Cursor Bugbot could review it.`,
        "Bugbot reported no issues and the extra mirror had no additional commits, so the mirror was closed without merging.",
      ])
    );

    await this.github.updatePullRequest({
      owner: original.owner,
      repo: original.repo,
      prNumber: shadowPr.number,
      state: "closed",
    });

    this.state.upsert({
      ...record,
      status: "closed_no_changes",
      originalHeadSha: original.headSha,
      shadowHeadSha: shadowPr.headSha,
      lastError: null,
      updatedAt: nowIso(),
    });
  }

  private async deliverSameRepo(
    original: TrackedPullRequest,
    record: ShadowRecord,
    shadowPr: TrackedPullRequest
  ): Promise<void> {
    logger.info("Retargeting shadow PR onto the original PR head branch.", {
      repo: repoFullName(original),
      originalPr: original.number,
      shadowPr: shadowPr.number,
      newBase: original.headRef,
    });

    await this.github.updatePullRequest({
      owner: original.owner,
      repo: original.repo,
      prNumber: shadowPr.number,
      base: original.headRef,
    });

    try {
      await this.github.requestReviewers({
        owner: original.owner,
        repo: original.repo,
        prNumber: shadowPr.number,
        reviewers: [original.authorLogin],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to request review from original PR author.", {
        error: message,
        repo: repoFullName(original),
        originalPr: original.number,
        reviewer: original.authorLogin,
      });
    }

    await this.commentOnce(
      original.owner,
      original.repo,
      original.number,
      COMMENT_DELIVERING,
      buildHostComment(COMMENT_DELIVERING, [
        `[bugbot-host](https://github.com/Senna46/bugbot-host) finished Cursor Bugbot / Fixooly on a mirror of this PR.`,
        `Please review #${shadowPr.number}. Its base was changed to \`${original.headRef}\` so the extra commits (Bugbot fixes) can be merged into this branch.`,
        "**Do not merge the mirror into the repository default branch.**",
      ])
    );

    this.state.upsert({
      ...record,
      status: "delivering",
      originalHeadSha: original.headSha,
      shadowHeadSha: shadowPr.headSha,
      originalHeadRef: original.headRef,
      lastError: null,
      updatedAt: nowIso(),
    });
  }

  private async notifyFork(
    original: TrackedPullRequest,
    record: ShadowRecord,
    shadowPr: TrackedPullRequest
  ): Promise<void> {
    logger.info("Fork PR has extra shadow commits. Notifying original author.", {
      repo: repoFullName(original),
      originalPr: original.number,
      shadowPr: shadowPr.number,
      shadowBranch: record.shadowBranch,
    });

    await this.commentOnce(
      original.owner,
      original.repo,
      original.number,
      COMMENT_FORK_FIXES,
      buildHostComment(COMMENT_FORK_FIXES, [
        `[bugbot-host](https://github.com/Senna46/bugbot-host) ran Cursor Bugbot / Fixooly on a mirror of this fork PR.`,
        `The mirror was closed so it cannot be merged into the default branch. Extra commits are on \`${record.shadowBranch}\` (see #${shadowPr.number}).`,
        "To apply those commits onto this PR branch:",
        "```bash",
        `git fetch origin ${record.shadowBranch}`,
        `git merge origin/${record.shadowBranch}`,
        "```",
      ])
    );

    await this.github.updatePullRequest({
      owner: original.owner,
      repo: original.repo,
      prNumber: shadowPr.number,
      state: "closed",
    });

    this.state.upsert({
      ...record,
      status: "fork_notified",
      originalHeadSha: original.headSha,
      shadowHeadSha: shadowPr.headSha,
      lastError: null,
      updatedAt: nowIso(),
    });
  }

  private async closeBecauseTooOld(
    original: TrackedPullRequest,
    record: ShadowRecord,
    minPrCreatedAt: string
  ): Promise<void> {
    if (record.status === "closed") {
      return;
    }

    logger.info(
      "Closing shadow PR because the original was already open before the cutoff.",
      {
        repo: record.repo,
        originalPr: record.originalPr,
        shadowPr: record.shadowPr,
        createdAt: original.createdAt,
        minPrCreatedAt,
      }
    );

    if (record.shadowPr !== null) {
      const [owner, repo] = splitRepo(record.repo);
      const shadowPr = await this.github.getPullRequest(
        owner,
        repo,
        record.shadowPr
      );
      if (shadowPr && shadowPr.state === "open") {
        await this.commentOnce(
          owner,
          repo,
          shadowPr.number,
          COMMENT_TOO_OLD,
          buildHostComment(COMMENT_TOO_OLD, [
            "[bugbot-host](https://github.com/Senna46/bugbot-host) only hosts **newly opened** pull requests.",
            `This original (#${original.number}) was created at ${original.createdAt}, which is before the cutoff ${minPrCreatedAt}. Closing this mirror without merging.`,
          ])
        );
        await this.github.updatePullRequest({
          owner,
          repo,
          prNumber: shadowPr.number,
          state: "closed",
        });
      }
    }

    this.state.upsert({
      ...record,
      status: "closed",
      lastError: `Ignored historical PR created at ${original.createdAt} (cutoff ${minPrCreatedAt})`,
      updatedAt: nowIso(),
    });
  }

  private requireMinPrCreatedAt(): string {
    if (!this.config.minPrCreatedAt) {
      throw new Error(
        "requireMinPrCreatedAt failed: minPrCreatedAt was not resolved before processing PRs."
      );
    }
    return this.config.minPrCreatedAt;
  }

  private async closeBecauseOriginalDone(
    original: TrackedPullRequest | null,
    record: ShadowRecord
  ): Promise<void> {
    if (record.status === "closed") {
      return;
    }

    logger.info("Original PR is closed or merged. Closing shadow PR.", {
      repo: record.repo,
      originalPr: record.originalPr,
      shadowPr: record.shadowPr,
    });

    if (record.shadowPr !== null) {
      const [owner, repo] = splitRepo(record.repo);
      const shadowPr = await this.github.getPullRequest(
        owner,
        repo,
        record.shadowPr
      );
      if (shadowPr && shadowPr.state === "open") {
        await this.github.updatePullRequest({
          owner,
          repo,
          prNumber: shadowPr.number,
          state: "closed",
        });
      }
    }

    if (original && original.state === "closed") {
      await this.commentOnce(
        original.owner,
        original.repo,
        original.number,
        COMMENT_ORIGINAL_CLOSED,
        buildHostComment(COMMENT_ORIGINAL_CLOSED, [
          `[bugbot-host](https://github.com/Senna46/bugbot-host) closed the Bugbot mirror because this PR was merged or closed.`,
        ])
      );
    }

    this.state.upsert({
      ...record,
      status: "closed",
      lastError: null,
      updatedAt: nowIso(),
    });
  }

  private async commentOnce(
    owner: string,
    repo: string,
    prNumber: number,
    marker: string,
    body: string
  ): Promise<void> {
    // Substring match: a legacy body that concatenated ":sha" after the HTML
    // comment still counts as already posted for delivering / no_changes /
    // fork_fixes.
    for (const candidate of commentMarkersToMatch(marker)) {
      const already = await this.github.hasIssueCommentContaining(
        owner,
        repo,
        prNumber,
        candidate
      );
      if (already) {
        return;
      }
    }
    await this.github.createIssueComment(owner, repo, prNumber, body);
  }

  private async commentConflictFailure(
    original: TrackedPullRequest,
    unmergedFiles: string[],
    mode: "merge" | "cherry-pick"
  ): Promise<void> {
    const marker = `<!-- BUGBOT_HOST_COMMENT: conflict_failed:${original.headSha} -->`;
    const body = buildHostComment(marker, [
      `[bugbot-host](https://github.com/Senna46/bugbot-host) failed to resolve a ${mode} conflict while syncing original PR #${original.number}.`,
      "Unmerged files:",
      unmergedFiles.map((path) => `- \`${path}\``).join("\n"),
      "The sync was aborted and will be retried on the next polling cycle.",
    ]);

    await this.commentOnce(
      original.owner,
      original.repo,
      original.number,
      marker,
      body
    );
  }
}

function repoFullName(pr: TrackedPullRequest): string {
  return `${pr.owner}/${pr.repo}`;
}

function splitRepo(repo: string): [string, string] {
  const parts = repo.split("/");
  if (parts.length !== 2) {
    throw new Error(`splitRepo failed: expected owner/name, got "${repo}"`);
  }
  return [parts[0], parts[1]];
}

function inferAdoptedShadowStatus(
  existing: TrackedPullRequest,
  original: TrackedPullRequest
): ShadowStatus {
  // Adopting an existing hosted PR after the DB record was lost. GitHub only
  // exposes open/closed, so a closed hosted PR is mapped to a resumable pause
  // state (not terminal "closed") so new original commits restart hosting.
  // An open, same-repo hosted PR already retargeted onto the original head
  // branch is "delivering", not "mirroring" - otherwise its base would be
  // forced back onto the repository default branch. Fork PRs are never
  // retargeted (they are closed instead), so this check must not apply to
  // them: forks commonly reuse the default branch name as their head branch,
  // which would otherwise make a still-mirroring hosted PR look delivered.
  if (existing.state === "closed") {
    return "closed_no_changes";
  }
  if (!original.isCrossRepo && existing.baseRef === original.headRef) {
    return "delivering";
  }
  return "mirroring";
}

function buildShadowTitle(original: TrackedPullRequest): string {
  return `[bugbot-host] #${original.number}: ${original.title}`;
}

function buildShadowBody(
  original: TrackedPullRequest,
  authorLogin: string
): string {
  return [
    buildOriginalMarker(original.owner, original.repo, original.number),
    MANAGED_MARKER,
    "",
    `This pull request is an automated [bugbot-host](https://github.com/Senna46/bugbot-host) mirror of #${original.number}.`,
    "",
    `Cursor Bugbot (Individual) only reviews PRs authored by @${authorLogin}. This mirror exists so Bugbot and Fixooly can run.`,
    "",
    "**Do not merge this PR into the default branch.** bugbot-host will retarget it or close it automatically.",
    "",
    `Original author: @${original.authorLogin}`,
    `Original: ${original.htmlUrl}`,
  ].join("\n");
}

function buildRecord(
  original: TrackedPullRequest,
  fields: Partial<ShadowRecord> & {
    shadowPr: number | null;
    shadowBranch: string;
    status: ShadowRecord["status"];
  }
): ShadowRecord {
  return {
    repo: repoFullName(original),
    originalPr: original.number,
    shadowPr: fields.shadowPr,
    shadowBranch: fields.shadowBranch,
    originalHeadSha: fields.originalHeadSha ?? original.headSha,
    shadowHeadSha: fields.shadowHeadSha ?? null,
    originalAuthor: original.authorLogin,
    originalBaseRef: original.baseRef,
    originalHeadRef: original.headRef,
    isCrossRepo: original.isCrossRepo,
    status: fields.status,
    lastError: fields.lastError ?? null,
    updatedAt: nowIso(),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildHostComment(marker: string, paragraphs: string[]): string {
  return [marker, ...paragraphs].join("\n\n");
}

function commentMarkersToMatch(marker: string): string[] {
  const markers = [marker];
  if (marker.includes("BUGBOT_HOST_COMMENT")) {
    markers.push(marker.replaceAll("BUGBOT_HOST_COMMENT", "PR_SHADOW_COMMENT"));
  }
  return markers;
}
