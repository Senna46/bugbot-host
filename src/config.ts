// Configuration loader for bugbot-host.
// Reads BUGBOT_HOST_* environment variables (with dotenv support) and
// validates required settings. SHADOW_* names are still accepted as a
// temporary fallback from the former pr-shadow project.
// Uses a GitHub App for repository discovery and a user PAT so hosted
// PRs are authored by BUGBOT_HOST_AUTHOR_LOGIN.
// Limitations: Only supports environment variable configuration,
//   no config file support.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { config as dotenvConfig } from "dotenv";

import type { Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

// Always skipped, even when BUGBOT_HOST_EXCLUDED_REPOS is unset.
// Extra owner/repo names in that variable are added to this list.
const DEFAULT_EXCLUDED_REPOS = ["d6e-products/meikei"];

export function loadConfig(): Config {
  dotenvConfig();

  const appIdStr = readEnv("BUGBOT_HOST_APP_ID", "SHADOW_APP_ID");
  if (!appIdStr) {
    throw new Error("Configuration error: BUGBOT_HOST_APP_ID is required.");
  }
  const appId = parseInt(appIdStr, 10);
  if (isNaN(appId) || appId <= 0) {
    throw new Error(
      `Configuration error: BUGBOT_HOST_APP_ID must be a positive integer, got "${appIdStr}".`
    );
  }

  const privateKey = loadPrivateKey();

  const githubToken = readEnv("BUGBOT_HOST_GITHUB_TOKEN", "SHADOW_GITHUB_TOKEN");
  if (!githubToken) {
    throw new Error(
      "Configuration error: BUGBOT_HOST_GITHUB_TOKEN is required. " +
        "Use a classic PAT for Senna46 so hosted PRs are authored by that user " +
        "and git push triggers Bugbot webhooks."
    );
  }

  const authorLogin =
    readEnv("BUGBOT_HOST_AUTHOR_LOGIN", "SHADOW_AUTHOR_LOGIN") || "Senna46";

  const pollInterval = parsePositiveInt(
    readEnv("BUGBOT_HOST_POLL_INTERVAL", "SHADOW_POLL_INTERVAL"),
    120
  );

  const defaultWorkDir = join(homedir(), ".bugbot-host", "repos");
  const workDir =
    readEnv("BUGBOT_HOST_WORK_DIR", "SHADOW_WORK_DIR") || defaultWorkDir;

  const defaultDbPath = join(homedir(), ".bugbot-host", "state.db");
  const dbPath =
    readEnv("BUGBOT_HOST_DB_PATH", "SHADOW_DB_PATH") || defaultDbPath;

  const claudeModel =
    readEnv("BUGBOT_HOST_CLAUDE_MODEL", "SHADOW_CLAUDE_MODEL") || null;
  const logLevel = parseLogLevel(
    readEnv("BUGBOT_HOST_LOG_LEVEL", "SHADOW_LOG_LEVEL")
  );
  const minPrCreatedAt = parseOptionalIsoDate(
    readEnv("BUGBOT_HOST_MIN_PR_CREATED_AT", "SHADOW_MIN_PR_CREATED_AT")
  );
  const excludedRepos = parseExcludedRepos(
    readEnv("BUGBOT_HOST_EXCLUDED_REPOS", "SHADOW_EXCLUDED_REPOS")
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
    excludedRepos,
  };
}

function readEnv(name: string, legacyName: string): string | undefined {
  const current = process.env[name]?.trim();
  if (current) {
    return current;
  }
  const legacy = process.env[legacyName]?.trim();
  return legacy || undefined;
}

function loadPrivateKey(): string {
  const privateKeyPath = readEnv(
    "BUGBOT_HOST_PRIVATE_KEY_PATH",
    "SHADOW_PRIVATE_KEY_PATH"
  );
  const privateKeyEnv = readEnv("BUGBOT_HOST_PRIVATE_KEY", "SHADOW_PRIVATE_KEY");

  if (privateKeyPath) {
    try {
      return readFileSync(privateKeyPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Configuration error: Failed to read private key from BUGBOT_HOST_PRIVATE_KEY_PATH="${privateKeyPath}": ${message}`
      );
    }
  }

  if (privateKeyEnv) {
    return privateKeyEnv;
  }

  throw new Error(
    "Configuration error: Either BUGBOT_HOST_PRIVATE_KEY_PATH or BUGBOT_HOST_PRIVATE_KEY must be set."
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
      `Configuration error: BUGBOT_HOST_MIN_PR_CREATED_AT must be a valid ISO 8601 date, got "${value}".`
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

function parseExcludedRepos(value: string | undefined): string[] {
  const fromEnv = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const invalid = fromEnv.filter((name) => !/^[^/\s]+\/[^/\s]+$/.test(name));
  if (invalid.length > 0) {
    throw new Error(
      `Configuration error: BUGBOT_HOST_EXCLUDED_REPOS entries must be owner/repo, got "${invalid.join(", ")}".`
    );
  }

  const excluded = [...DEFAULT_EXCLUDED_REPOS];
  for (const name of fromEnv) {
    const alreadyListed = excluded.some(
      (existing) => existing.toLowerCase() === name.toLowerCase()
    );
    if (!alreadyListed) {
      excluded.push(name);
    }
  }
  return excluded;
}
