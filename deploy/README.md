# pr-shadow daemon (launchd)

Run pr-shadow as a native macOS LaunchAgent so it starts on login and restarts on failure.

## Prerequisites

- `.env` configured (copy from `.env.example`)
- `npm run build` completed
- `claude` CLI installed and on PATH (`~/.local/bin` is included by default)

## Install

From the project root:

```bash
chmod +x deploy/install-daemon.sh
./deploy/install-daemon.sh
```

The script copies the LaunchAgent plist to `~/Library/LaunchAgents/`, creates `~/.pr-shadow/logs/`, and loads the job.

## Commands

| Action | Command |
| --- | --- |
| Check status | `launchctl list \| grep pr-shadow` |
| Stop | `launchctl stop com.senna.pr-shadow` |
| Start | `launchctl start com.senna.pr-shadow` |
| Unload | `launchctl unload ~/Library/LaunchAgents/com.senna.pr-shadow.plist` |
| View stdout | `tail -f ~/.pr-shadow/logs/stdout.log` |
| View stderr | `tail -f ~/.pr-shadow/logs/stderr.log` |

## Update after code changes

1. `npm run build`
2. `launchctl stop com.senna.pr-shadow && launchctl start com.senna.pr-shadow`

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.senna.pr-shadow.plist
rm ~/Library/LaunchAgents/com.senna.pr-shadow.plist
```
