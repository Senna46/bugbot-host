# Rename pr-shadow to bugbot-host

Related issue: https://github.com/Senna46/pr-shadow/issues/4

## Goal

Rename the product from pr-shadow to bugbot-host so the purpose (hosting other
people's PRs for Cursor Bugbot) is obvious. Keep recognizing existing
`pr-shadow/*` branches, `PR_SHADOW_*` HTML markers, and `SHADOW_*` env vars so
already-created hosted PRs are not processed twice.

## User-facing names

- GitHub repo: `Senna46/bugbot-host` (rename after this PR merges)
- Local clone: `/Volumes/Samsung980_1TB/github.com/Senna46/bugbot-host`
- LaunchAgent: `com.senna.bugbot-host`
- Data directory: `~/.bugbot-host/`
- Env prefix: `BUGBOT_HOST_*` (`SHADOW_*` still accepted)
- New hosted branches: `bugbot-host/{n}`
- New HTML markers: `BUGBOT_HOST_*`

## Compatibility (must keep working)

- Detect `pr-shadow/{n}` head branches as managed mirrors
- Detect `<!-- PR_SHADOW_ORIGINAL` / `<!-- PR_SHADOW_MANAGED -->`
- Detect `<!-- PR_SHADOW_COMMENT:` so delivery comments are not posted twice
- Reuse an existing `pr-shadow/{n}` PR instead of opening `bugbot-host/{n}`
- SQLite table name `shadow_prs` stays internal
- `install-daemon.sh` unloads `com.senna.pr-shadow` and moves `~/.pr-shadow`
  when `~/.bugbot-host` does not exist yet

## After merge (ops, not this PR)

1. `gh repo rename bugbot-host`
2. Move the local directory to `bugbot-host`
3. Rewrite local `.env` to `BUGBOT_HOST_*`
4. `./deploy/install-daemon.sh`
