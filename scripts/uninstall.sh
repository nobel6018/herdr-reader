#!/usr/bin/env bash
# Stops herdr-reader and removes its LaunchAgent. The log file stays.
# @see docs/herdr-reader.md
set -euo pipefail

LABEL="local.herdr-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "제거했습니다: $PLIST"
