# CLAUDE.md

Instructions for Claude Code when working on this codebase.

## Project Overview

pr-shadow is a TypeScript daemon that mirrors other people's GitHub PRs as
Senna46-authored PRs so Cursor Bugbot can review them. After Bugbot and
Fixooly finish with a successful Cursor Bugbot check, extra commits are
delivered back to the original PR (retarget + review request) or the
mirror is closed if there is no extra diff.

This project does NOT fix bugs itself. Fixooly still performs autofix on
the Senna46-authored mirror PR.

## Tech Stack

- Language: TypeScript (ES2022, Node16 modules)
- Runtime: Node.js >= 18
- Package Manager: npm
- GitHub API: Octokit (GitHub App for repo discovery, user PAT for PR writes)
- State: SQLite (via better-sqlite3)
- Config: dotenv
- Conflict resolution: claude -p CLI with Read and Edit tools

## Project Structure

 src/
 main.ts           PrShadowDaemon entry point, polling loop
 config.ts         SHADOW_* environment variable loader
 types.ts          Shared interfaces
 logger.ts         Structured logger with level support
 githubClient.ts   App + PAT Octokit wrapper
 prMonitor.ts      Eligibility filters for original PRs
 shadowManager.ts  Create / sync / retarget / close / notify
 gitOps.ts         Clone, fetch pull/{n}/head, merge, cherry-pick
 conflictResolver.ts claude -p merge conflict resolution
 state.ts          SQLite shadow_prs table

## Build and Run Commands

 npm install
 npm run build
 npm start
 npm run dev
 npm run typecheck

## Coding Conventions

- ESM modules: all imports use .js extension
- lowerCamelCase for variables, functions, properties, and methods
- Structured logging: logger.info("message", { key: value })
- Error messages include function context and relevant parameters
- Comments at file top describe purpose and limitations (in English)
- User-facing text (logs, PR comments) in English
- Git commit messages in English only

## Important Notes

- Mirror PRs MUST be created with SHADOW_GITHUB_TOKEN (Senna46 PAT).
  GitHub App installation tokens would author the PR as a bot and Bugbot
  would skip them.
- Push also uses the PAT so GitHub webhooks fire for Bugbot.
- Completion is Cursor Bugbot check conclusion=success. Do not wait for
  GitHub Actions.
- Never merge a mirror PR into a repository default branch.
- Fork PRs are not retargeted; extras are delivered as a comment + leftover branch.
- Only **open** PRs created at or after `minPrCreatedAt` are mirrored.
  Closed PRs and already-open historical PRs are out of scope.
