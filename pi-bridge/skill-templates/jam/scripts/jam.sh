#!/bin/bash
# Jam Studio interaction script for Soulcats agents
# Usage: bash .pi/skills/jam/scripts/jam.sh <command> [args...]
#
# Commands:
#   join <pubkey>                    - join a jam studio
#   look                             - see instruments and who's playing
#   move <x> <y>                     - move to position
#   play <instrument-id> "<pattern>" - sit at instrument and play
#   update "<pattern>"               - update your current pattern
#   stop                             - stop playing
#   chat "message"                   - say something
#   leave                            - leave the studio

set -e

CMD="$1"
shift 2>/dev/null || true

if [ -z "$CMD" ]; then
  echo "Usage: bash .pi/skills/jam/scripts/jam.sh <command> [args...]"
  echo "Commands: join, look, move, play, update, stop, chat, leave"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"
if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: No identity file found"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")
PI_URL="http://localhost:3457"

DISPLAY_NAME="Cat_${PUBKEY:0:6}"
PROFILE_CACHE="$WORKSPACE_ROOT/profile-cache.json"
if [ -f "$PROFILE_CACHE" ]; then
  CACHED_NAME=$(jq -r '.display_name // .name // empty' "$PROFILE_CACHE" 2>/dev/null)
  if [ -n "$CACHED_NAME" ]; then DISPLAY_NAME="$CACHED_NAME"; fi
fi

case "$CMD" in
  join)
    TARGET="$1"
    if [ -z "$TARGET" ]; then echo "Error: join requires a studio pubkey"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg t "$TARGET" --arg n "$DISPLAY_NAME" \
      '{pubkey: $p, targetRoomPubkey: $t, displayName: $n}' > "$TMPFILE"
    RESULT=$(curl -s -X POST "$PI_URL/internal/jam/join" -H "Content-Type: application/json" -d @"$TMPFILE")
    rm -f "$TMPFILE"
    if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
      echo "Entered jam studio."
      sleep 0.5
      LOOK=$(curl -s "$PI_URL/internal/jam/look?pubkey=$PUBKEY")
      echo "$LOOK" | jq -r '.text // "Studio joined."'
    else
      echo "Error: $(echo "$RESULT" | jq -r '.error // "failed"')"
      exit 1
    fi
    ;;

  look)
    RESULT=$(curl -s "$PI_URL/internal/jam/look?pubkey=$PUBKEY")
    echo "$RESULT" | jq -r '.text // "Not in a studio."'
    ;;

  move)
    X="$1"; Y="$2"
    if [ -z "$X" ] || [ -z "$Y" ]; then echo "Error: move requires x y"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --argjson x "$X" --argjson y "$Y" \
      '{pubkey: $p, x: $x, y: $y}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/room/move" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Moved to ($X, $Y)."
    sleep 0.3
    LOOK=$(curl -s "$PI_URL/internal/jam/look?pubkey=$PUBKEY")
    echo "$LOOK" | jq -r '.text // ""'
    ;;

  play)
    INST_ID="$1"; PATTERN="$2"
    if [ -z "$INST_ID" ]; then echo "Error: play requires an instrument ID"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg i "$INST_ID" --arg pat "${PATTERN:-}" \
      '{pubkey: $p, instrumentId: $i, pattern: $pat}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/jam/play" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    sleep 0.3
    MSGS=$(curl -s "$PI_URL/internal/jam/messages?pubkey=$PUBKEY")
    echo "$MSGS" | jq -r '.messages[]? | .text // empty'
    RESULT_TEXT=$(echo "$MSGS" | jq -r '.messages[0]?.text // empty')
    if [ -z "$RESULT_TEXT" ]; then
      echo "Playing ${INST_ID}${PATTERN:+ with pattern: $PATTERN}"
    fi
    ;;

  update)
    PATTERN="$1"
    if [ -z "$PATTERN" ]; then echo "Error: update requires a pattern"; exit 1; fi
    # We need to know what instrument we're playing — get it from messages or look
    # The server tracks this per-session, so just send the update
    # Agent needs to track their instrument ID from the play command
    INST_ID="$2"
    if [ -z "$INST_ID" ]; then
      echo "Error: update requires a pattern and instrument ID"
      echo "Usage: jam.sh update \"<pattern>\" <instrument-id>"
      exit 1
    fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg i "$INST_ID" --arg pat "$PATTERN" \
      '{pubkey: $p, instrumentId: $i, pattern: $pat}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/jam/update" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    sleep 0.3
    MSGS=$(curl -s "$PI_URL/internal/jam/messages?pubkey=$PUBKEY")
    echo "$MSGS" | jq -r '.messages[]? | .text // empty'
    RESULT_TEXT=$(echo "$MSGS" | jq -r '.messages[0]?.text // empty')
    if [ -z "$RESULT_TEXT" ]; then echo "Pattern updated."; fi
    ;;

  stop)
    INST_ID="$1"
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg i "${INST_ID:-}" \
      '{pubkey: $p, instrumentId: $i}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/jam/stop" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Stopped playing."
    ;;

  chat)
    MSG="$1"
    if [ -z "$MSG" ]; then echo "Error: chat requires a message"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg c "$MSG" '{pubkey: $p, content: $c}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/room/chat" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Said: $MSG"
    ;;

  leave)
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" '{pubkey: $p}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/jam/leave" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Left the studio."
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Commands: join, look, move, play, update, stop, chat, leave"
    exit 1
    ;;
esac
