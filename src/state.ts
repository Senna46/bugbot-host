// SQLite-based state management for bugbot-host.
// Tracks one shadow PR mapping per original PR so the daemon can
// resume mirroring, retargeting, and close/reopen decisions across
// polling cycles.
// Limitations: Single-process only; no concurrent access support.

import { mkdirSync } from "fs";
import { dirname } from "path";

import Database from "better-sqlite3";

import { logger } from "./logger.js";
import type { ShadowRecord, ShadowStatus } from "./types.js";

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();

    logger.debug("State store initialized.", { dbPath });
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_prs (
        repo TEXT NOT NULL,
        original_pr INTEGER NOT NULL,
        shadow_pr INTEGER,
        shadow_branch TEXT NOT NULL,
        original_head_sha TEXT,
        shadow_head_sha TEXT,
        original_author TEXT NOT NULL,
        original_base_ref TEXT NOT NULL,
        original_head_ref TEXT NOT NULL,
        is_cross_repo INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo, original_pr)
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_prs_status
        ON shadow_prs (status);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  get(repo: string, originalPr: number): ShadowRecord | null {
    const row = this.db
      .prepare(
        `SELECT repo, original_pr, shadow_pr, shadow_branch,
                original_head_sha, shadow_head_sha, original_author,
                original_base_ref, original_head_ref, is_cross_repo,
                status, last_error, updated_at
         FROM shadow_prs
         WHERE repo = ? AND original_pr = ?`
      )
      .get(repo, originalPr) as ShadowRow | undefined;

    return row ? rowToRecord(row) : null;
  }

  listForRepo(repo: string): ShadowRecord[] {
    const rows = this.db
      .prepare(
        `SELECT repo, original_pr, shadow_pr, shadow_branch,
                original_head_sha, shadow_head_sha, original_author,
                original_base_ref, original_head_ref, is_cross_repo,
                status, last_error, updated_at
         FROM shadow_prs
         WHERE repo = ?`
      )
      .all(repo) as ShadowRow[];

    return rows.map(rowToRecord);
  }

  upsert(record: ShadowRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shadow_prs (
           repo, original_pr, shadow_pr, shadow_branch,
           original_head_sha, shadow_head_sha, original_author,
           original_base_ref, original_head_ref, is_cross_repo,
           status, last_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.repo,
        record.originalPr,
        record.shadowPr,
        record.shadowBranch,
        record.originalHeadSha,
        record.shadowHeadSha,
        record.originalAuthor,
        record.originalBaseRef,
        record.originalHeadRef,
        record.isCrossRepo ? 1 : 0,
        record.status,
        record.lastError,
        record.updatedAt
      );

    logger.debug("Upserted shadow record.", {
      repo: record.repo,
      originalPr: record.originalPr,
      shadowPr: record.shadowPr,
      status: record.status,
    });
  }

  // Persist the cutoff used to ignore already-open historical PRs.
  // If BUGBOT_HOST_MIN_PR_CREATED_AT is unset, the first run of this code stores
  // "now". shadow_prs.updated_at cannot be used: it is rewritten every poll.
  ensureMinPrCreatedAt(envValue: string | null): string {
    if (envValue) {
      this.setMeta("min_pr_created_at", envValue);
      return envValue;
    }

    const stored = this.getMeta("min_pr_created_at");
    if (stored) {
      return stored;
    }

    const resolved = new Date().toISOString();
    this.setMeta("min_pr_created_at", resolved);
    return resolved;
  }

  private getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
    logger.debug("State store closed.");
  }
}

interface ShadowRow {
  repo: string;
  original_pr: number;
  shadow_pr: number | null;
  shadow_branch: string;
  original_head_sha: string | null;
  shadow_head_sha: string | null;
  original_author: string;
  original_base_ref: string;
  original_head_ref: string;
  is_cross_repo: number;
  status: string;
  last_error: string | null;
  updated_at: string;
}

function rowToRecord(row: ShadowRow): ShadowRecord {
  return {
    repo: row.repo,
    originalPr: row.original_pr,
    shadowPr: row.shadow_pr,
    shadowBranch: row.shadow_branch,
    originalHeadSha: row.original_head_sha,
    shadowHeadSha: row.shadow_head_sha,
    originalAuthor: row.original_author,
    originalBaseRef: row.original_base_ref,
    originalHeadRef: row.original_head_ref,
    isCrossRepo: row.is_cross_repo === 1,
    status: row.status as ShadowStatus,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
