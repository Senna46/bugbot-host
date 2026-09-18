#!/bin/sh
# Installs bugbot-host as a user LaunchAgent (runs on login, restarts on failure).
# Run from the project root: ./deploy/install-daemon.sh
# Requires: npm run build already done, .env configured.
# Unloads the former com.senna.pr-shadow job if present and moves
# ~/.pr-shadow to ~/.bugbot-host when the new data directory is missing.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_NAME="com.senna.bugbot-host"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
PLIST_DEST="${LAUNCH_AGENTS}/${PLIST_NAME}.plist"
LOG_DIR="${HOME}/.bugbot-host/logs"
OLD_PLIST="${LAUNCH_AGENTS}/com.senna.pr-shadow.plist"
OLD_DATA_DIR="${HOME}/.pr-shadow"
NEW_DATA_DIR="${HOME}/.bugbot-host"

if [ ! -f "$PROJECT_ROOT/dist/main.js" ]; then
  echo "Error: dist/main.js not found. Run 'npm run build' first."
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/.env" ]; then
  echo "Warning: .env not found. Copy .env.example to .env and configure."
fi

NODE_BIN="$(which node)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi

if [ -f "$OLD_PLIST" ]; then
  echo "Unloading former pr-shadow daemon..."
  launchctl unload "$OLD_PLIST" 2>/dev/null || true
  rm -f "$OLD_PLIST"
fi

if [ -d "$OLD_DATA_DIR" ] && [ ! -d "$NEW_DATA_DIR" ]; then
  echo "Moving $OLD_DATA_DIR to $NEW_DATA_DIR"
  mv "$OLD_DATA_DIR" "$NEW_DATA_DIR"
fi

mkdir -p "$LAUNCH_AGENTS"
mkdir -p "$LOG_DIR"

escape_sed() {
  printf '%s\n' "$1" | sed -e 's/[&\\/|]/\\&/g'
}
SAFE_PROJECT_ROOT="$(escape_sed "$PROJECT_ROOT")"
SAFE_HOME="$(escape_sed "$HOME")"
SAFE_NODE_BIN="$(escape_sed "$NODE_BIN")"

sed -e "s|__PROJECT_ROOT__|$SAFE_PROJECT_ROOT|g" -e "s|__HOME__|$SAFE_HOME|g" -e "s|__NODE_PATH__|$SAFE_NODE_BIN|g" \
  "$SCRIPT_DIR/bugbot-host-daemon.plist" > "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "bugbot-host daemon installed. Logs: $LOG_DIR/stdout.log and $LOG_DIR/stderr.log"
echo "Commands: launchctl list | grep bugbot-host | start/stop: launchctl start/stop $PLIST_NAME"
