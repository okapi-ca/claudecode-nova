#!/bin/sh
# hook-relay.sh — forward a Claude Code hook event to the Nova bridge.
#
# Installed into ~/.claude/settings.json by the extension's "Install Claude
# Code Hooks" command as an async command hook on the session-state events
# (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest,
# Notification, Stop, StopFailure, SessionEnd). Claude Code pipes the event
# JSON on stdin; we find every Nova bridge whose workspace contains the
# event's cwd (via the ~/.claude/ide/<port>.lock files our ws-server writes)
# and POST the payload to its /hook endpoint with the lock's auth token.
#
# Deliberately POSIX sh + sed + curl only: hooks run in whatever shell Claude
# was launched from, where node (nvm) may not be on PATH. Always exits 0 —
# the hook is registered async, and a dead bridge must never bother Claude.

payload=$(cat)
[ -n "$payload" ] || exit 0

# Hook input is one JSON object; cwd is a plain absolute path. Tolerate an
# optional space after the colon (pretty-printed vs compact).
cwd=$(printf '%s' "$payload" | sed -n 's/.*"cwd":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$cwd" ] || exit 0

dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ide"
[ -d "$dir" ] || exit 0

for lock in "$dir"/*.lock; do
  [ -f "$lock" ] || continue
  grep -q '"ideName":[[:space:]]*"Nova"' "$lock" 2>/dev/null || continue

  # Skip stale locks left behind by a bridge that died without cleanup.
  pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$lock" | head -1)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then continue; fi

  # Deliver only to bridges whose workspace folder contains the session cwd.
  # The lock is pretty-printed JSON: one quoted absolute path per line inside
  # the workspaceFolders array. Paths may contain spaces, hence the read loop.
  if sed -n '/"workspaceFolders"/,/\]/p' "$lock" \
      | sed -n 's/^[[:space:]]*"\(\/[^"]*\)".*/\1/p' \
      | while IFS= read -r folder; do
          case "$cwd" in
            "$folder"|"$folder"/*) echo hit ;;
          esac
        done | grep -q hit; then
    token=$(sed -n 's/.*"authToken":[[:space:]]*"\([^"]*\)".*/\1/p' "$lock" | head -1)
    port=$(basename "$lock" .lock)
    [ -n "$token" ] && [ -n "$port" ] || continue
    curl -s -m 2 -o /dev/null -X POST \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data-binary "$payload" \
      "http://127.0.0.1:$port/hook" 2>/dev/null
  fi
done

exit 0
