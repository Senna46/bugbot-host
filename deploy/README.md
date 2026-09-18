# bugbot-host daemon (launchd)

Run bugbot-host as a native macOS LaunchAgent so it starts on login and restarts on failure.

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

The script copies the LaunchAgent plist to `~/Library/LaunchAgents/`, creates `~/.bugbot-host/logs/`, unloads the former `com.senna.pr-shadow` job if present, and loads the new job.

## Commands

| Action | Command |
| --- | --- |
| Check status | `launchctl list \| grep bugbot-host` |
| Stop | `launchctl stop com.senna.bugbot-host` |
| Start | `launchctl start com.senna.bugbot-host` |
| Unload | `launchctl unload ~/Library/LaunchAgents/com.senna.bugbot-host.plist` |
| View stdout | `tail -f ~/.bugbot-host/logs/stdout.log` |
| View stderr | `tail -f ~/.bugbot-host/logs/stderr.log` |

## Update after code changes

1. `npm run build`
2. `launchctl stop com.senna.bugbot-host && launchctl start com.senna.bugbot-host`

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.senna.bugbot-host.plist
rm ~/Library/LaunchAgents/com.senna.bugbot-host.plist
```
