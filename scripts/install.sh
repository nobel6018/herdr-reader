#!/usr/bin/env bash
# Installs herdr-reader as a LaunchAgent that starts at login and restarts on crash.
#   scripts/install.sh            install (or reinstall) and start
#   scripts/install.sh --dry-run  print the LaunchAgent plist and change nothing
# Settings come from the environment: HERDR_READER_PORT (default 7878),
# HERDR_READER_ALLOWED_LOGIN (Tailscale login allowed in; empty allows anyone who reaches it).
# @see docs/herdr-reader.md
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.herdr-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/herdr-reader.log"
PORT="${HERDR_READER_PORT:-7878}"
LOGIN="${HERDR_READER_ALLOWED_LOGIN:-}"

BUN="$(command -v bun || true)"
HC="$(command -v hc || true)"
[ -n "$BUN" ] || { echo "bun을 찾지 못했습니다. https://bun.sh 에서 설치하세요." >&2; exit 1; }
[ -n "$HC" ] || { echo "hc를 찾지 못했습니다. herdr를 먼저 설치하세요." >&2; exit 1; }

case "$PORT" in (*[!0-9]*|"") echo "HERDR_READER_PORT는 숫자여야 합니다: $PORT" >&2; exit 1;; esac
case "$LOGIN" in (*[\<\>\&\|]*) echo "HERDR_READER_ALLOWED_LOGIN에 쓸 수 없는 문자가 있습니다." >&2; exit 1;; esac

# launchd starts with a bare PATH: hc and bun, plus ps and lsof for finding transcripts.
PATH_VALUE="$(dirname "$HC"):$(dirname "$BUN"):/usr/bin:/bin:/usr/sbin:/sbin"

render() {
  sed -e "s|__LABEL__|$LABEL|g" \
      -e "s|__BUN__|$BUN|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__PATH__|$PATH_VALUE|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__LOGIN__|$LOGIN|g" \
      -e "s|__LOG__|$LOG|g" \
      "$REPO/scripts/herdr-reader.plist.template"
}

if [ "${1:-}" = "--dry-run" ]; then
  render
  exit 0
fi

(cd "$REPO" && "$BUN" install --frozen-lockfile --production)

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
render > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "설치했습니다: $PLIST"
echo "주소: http://127.0.0.1:$PORT  (로그: $LOG)"
[ -n "$LOGIN" ] || echo "주의: HERDR_READER_ALLOWED_LOGIN이 비어 있어 이 포트에 닿는 누구나 에이전트에 입력할 수 있습니다."
