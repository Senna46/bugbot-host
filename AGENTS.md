# AGENTS.md

Guidelines for AI agents working on this codebase.

## Repository Purpose

This is **bugbot-host**, a daemon that hosts other people's GitHub pull
requests as Senna46-authored PRs so Cursor Bugbot can review them. It does
NOT detect or fix bugs. Fixooly still commits fixes onto the hosted PR.

## Before Making Changes

1. Run `npm run typecheck` to verify the codebase compiles
2. Read the relevant source files before editing
3. Understand the polling flow (main.ts -> prMonitor -> shadowManager -> gitOps)

## Code Style Rules

- TypeScript with strict mode enabled
- ESM modules with `.js` import extensions
- lowerCamelCase for all identifiers
- Every source file starts with a comment block describing purpose and limitations
- All user-facing text (logs, GitHub comments) must be in English
- Git commit messages must be in English only
- Use structured logging: `logger.info("message", { contextKey: contextValue })`
- Error handling must include detailed context
- Prefer readability over efficiency
- Do not add JSDoc type definitions on TypeScript code

## Module Dependency Graph

 main.ts
 -> config.ts
 -> logger.ts
 -> githubClient.ts
 -> state.ts
 -> prMonitor.ts
 -> shadowManager.ts
    -> gitOps.ts
    -> conflictResolver.ts
 -> types.ts (shared by all)

## Testing Changes

After any code change:

 npm run typecheck
 npm run build

## Environment Variables

All config uses the `BUGBOT_HOST_` prefix. Former `SHADOW_*` names are still
accepted. Required:

- BUGBOT_HOST_APP_ID
- BUGBOT_HOST_PRIVATE_KEY_PATH or BUGBOT_HOST_PRIVATE_KEY
- BUGBOT_HOST_GITHUB_TOKEN (classic PAT as Senna46)

Monitored repositories are auto-discovered from the App installations.
`d6e-products/meikei` is always excluded. `BUGBOT_HOST_EXCLUDED_REPOS`
adds more `owner/repo` names.

## Common Tasks

### Adding a new config option

1. Add field to Config in types.ts
2. Parse it in config.ts loadConfig()
3. Add to .env.example with a documentation comment

### Changing delivery behavior

- Same-repo extras: shadowManager.deliverSameRepo()
- Fork extras: shadowManager.notifyFork()
- No extras: shadowManager.closeNoChanges()
- Bugbot readiness: GitHubClient.getCursorBugbotCheck()
