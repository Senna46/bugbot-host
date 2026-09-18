// Configuration loader for pr-shadow.
// Reads SHADOW_* environment variables (with dotenv support) and validates
// required settings. Uses a GitHub App for repository discovery and a
// user PAT so mirror PRs are authored by SHADOW_AUTHOR_LOGIN.
// Limitations: Only supports environment variable configuration,
//   no config file support.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { config as dotenvConfig } from "dotenv";

import type { Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(): Config {
  dotenvConfig();

  const appIdStr = process.env.SHADOW_APP_ID?.trim();
  if (!appIdStr) {
    throw new Error("Configuration error: SHADOW_APP_ID is required.");
  }
  const appId = parseInt(appIdStr, 10);
  if (isNaN(appId) || appId <= 0) {
    throw new Error(
      `Configuration error: SHADOW_APP_ID must be a positive integer, got "${appIdStr}".`
    );
  }

  const privateKey = loadPrivateKey();

  const githubToken = process.env.SHADOW_GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error(
      "Configuration error: SHADOW_GITHUB_TOKEN is required. " +
        "Use a classic PAT for Senna46 so mirror PRs are authored by that user " +
        "and git push triggers Bugbot webhooks."
    );
  }

  const authorLogin =
    process.env.SHADOW_AUTHOR_LOGIN?.trim() || "Senna46";

  const pollInterval = parsePositiveInt(
    process.env.SHADOW_POLL_INTERVAL,
    120
  );

  const defaultWorkDir = join(homedir(), ".pr-shadow", "repos");
  const workDir = process.env.SHADOW_WORK_DIR?.trim() || defaultWorkDir;

  const defaultDbPath = join(homedir(), ".pr-shadow", "state.db");
  const dbPath = process.env.SHADOW_DB_PATH?.trim() || defaultDbPath;

  const claudeModel = process.env.SHADOW_CLAUDE_MODEL?.trim() || null;
  const logLevel = parseLogLevel(process.env.SHADOW_LOG_LEVEL);
  const minPrCreatedAt = parseOptionalIsoDate(
    process.env.SHADOW_MIN_PR_CREATED_AT
  );

  return {
    appId,
    privateKey,
    githubToken,
    authorLogin,
    pollInterval,
    workDir,
    dbPath,
    claudeModel,
    logLevel,
    minPrCreatedAt,
  };
}

function loadPrivateKey(): string {
  const privateKeyPath = process.env.SHADOW_PRIVATE_KEY_PATH?.trim();
  const privateKeyEnv = process.env.SHADOW_PRIVATE_KEY?.trim();

  if (privateKeyPath) {
    try {
      return readFileSync(privateKeyPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Configuration error: Failed to read private key from SHADOW_PRIVATE_KEY_PATH="${privateKeyPath}": ${message}`
      );
    }
  }

  if (privateKeyEnv) {
    return privateKeyEnv;
  }

  throw new Error(
    "Configuration error: Either SHADOW_PRIVATE_KEY_PATH or SHADOW_PRIVATE_KEY must be set."
  );
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Configuration error: Expected a positive integer but got "${value}".`
    );
  }
  return parsed;
}

function parseOptionalIsoDate(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Configuration error: SHADOW_MIN_PR_CREATED_AT must be a valid ISO 8601 date, got "${value}".`
    );
  }
  return new Date(parsed).toISOString();
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Configuration error: Invalid log level "${value}". Valid levels: ${VALID_LOG_LEVELS.join(", ")}`
    );
  }
  return level;
}
