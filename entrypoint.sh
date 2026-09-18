#!/bin/bash
# Entrypoint for the bugbot-host Docker container.
# Verifies Claude CLI authentication and GitHub credentials
# before starting the daemon.

set -e

if [ -d /root/.claude.json ]; then
  echo "WARNING: /root/.claude.json is a directory. Removing and creating as file."
  rm -rf /root/.claude.json
  echo '{}' > /root/.claude.json
fi

if [ ! -f /root/.claude.json ]; then
  echo '{}' > /root/.claude.json
fi

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "Claude authentication configured via environment variable."
elif [ -f /root/.claude/.credentials.json ]; then
  echo "Claude authentication configured via credentials file."
else
  echo "WARNING: No Claude authentication detected."
  echo "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or mount ~/.claude with credentials."
fi

if { [ -n "$BUGBOT_HOST_APP_ID" ] || [ -n "$SHADOW_APP_ID" ]; } && { [ -n "$BUGBOT_HOST_PRIVATE_KEY_PATH" ] || [ -n "$BUGBOT_HOST_PRIVATE_KEY" ] || [ -n "$SHADOW_PRIVATE_KEY_PATH" ] || [ -n "$SHADOW_PRIVATE_KEY" ]; }; then
  echo "GitHub App credentials configured."
else
  echo "WARNING: GitHub App credentials incomplete."
  echo "Set BUGBOT_HOST_APP_ID and BUGBOT_HOST_PRIVATE_KEY_PATH (or BUGBOT_HOST_PRIVATE_KEY)."
fi

if [ -n "$BUGBOT_HOST_GITHUB_TOKEN" ] || [ -n "$SHADOW_GITHUB_TOKEN" ]; then
  echo "GitHub user PAT configured."
else
  echo "WARNING: BUGBOT_HOST_GITHUB_TOKEN is missing. Hosted PRs will not be authored by Senna46."
fi

echo "Starting bugbot-host daemon..."
exec node dist/main.js
