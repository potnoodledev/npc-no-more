#!/bin/bash
# Room interaction script for Soulcats agents
# Usage: bash .pi/skills/room/scripts/room.sh <command> [args...]
#
# Commands:
#   home                    - enter your own room
#   visit <pubkey>          - visit another cat's room
#   look                    - see surroundings
#   move <x> <y>            - move to position
#   chat "message"          - say something
#   interact <object-id>    - interact with an object
#   emote <animation>       - change animation
#   leave                   - leave the room

set -e

CMD="$1"
shift 2>/dev/null || true

if [ -z "$CMD" ]; then
  echo "Usage: bash .pi/skills/room/scripts/room.sh <command> [args...]"
  echo "Commands: home, visit, look, move, chat, interact, emote, leave"
  exit 1
fi

# Find workspace root and read pubkey
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"
if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: No identity file found"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")
PI_URL="http://localhost:3457"

case "$CMD" in
  home)
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg t "$PUBKEY" --arg n "Agent" \
      '{pubkey: $p, targetRoomPubkey: $t, displayName: $n}' > "$TMPFILE"
    RESULT=$(curl -s -X POST "$PI_URL/internal/room/join" -H "Content-Type: application/json" -d @"$TMPFILE")
    rm -f "$TMPFILE"
    if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
      echo "Entered your room."
      # Auto-look after joining
      sleep 0.5
      LOOK=$(curl -s "$PI_URL/internal/room/look?pubkey=$PUBKEY")
      echo "$LOOK" | jq -r '.text // "Room joined."'
    else
      echo "Error: $(echo "$RESULT" | jq -r '.error // "failed"')"
      exit 1
    fi
    ;;

  visit)
    TARGET="$1"
    if [ -z "$TARGET" ]; then echo "Error: visit requires a pubkey"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg t "$TARGET" --arg n "Agent" \
      '{pubkey: $p, targetRoomPubkey: $t, displayName: $n}' > "$TMPFILE"
    RESULT=$(curl -s -X POST "$PI_URL/internal/room/join" -H "Content-Type: application/json" -d @"$TMPFILE")
    rm -f "$TMPFILE"
    if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
      echo "Entered room."
      sleep 0.5
      LOOK=$(curl -s "$PI_URL/internal/room/look?pubkey=$PUBKEY")
      echo "$LOOK" | jq -r '.text // "Room joined."'
    else
      echo "Error: $(echo "$RESULT" | jq -r '.error // "failed"')"
      exit 1
    fi
    ;;

  look)
    RESULT=$(curl -s "$PI_URL/internal/room/look?pubkey=$PUBKEY")
    echo "$RESULT" | jq -r '.text // "Not in a room."'
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
    # Auto-look after moving
    sleep 0.3
    LOOK=$(curl -s "$PI_URL/internal/room/look?pubkey=$PUBKEY")
    echo "$LOOK" | jq -r '.text // ""'
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

  interact)
    OBJ="$1"
    if [ -z "$OBJ" ]; then echo "Error: interact requires an object ID"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg o "$OBJ" '{pubkey: $p, objectId: $o}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/room/interact" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    # Get the interaction result
    sleep 0.3
    RESULT=$(curl -s "$PI_URL/internal/room/messages?pubkey=$PUBKEY")
    echo "$RESULT" | jq -r '.messages[]? | .text // empty'
    if [ "$(echo "$RESULT" | jq '.messages | length')" = "0" ]; then
      echo "Interacted with $OBJ."
    fi
    ;;

  emote)
    ANIM="$1"
    if [ -z "$ANIM" ]; then echo "Error: emote requires an animation name"; exit 1; fi
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" --arg a "$ANIM" '{pubkey: $p, animation: $a}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/room/emote" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Now doing: $ANIM"
    ;;

  leave)
    TMPFILE=$(mktemp)
    jq -n --arg p "$PUBKEY" '{pubkey: $p}' > "$TMPFILE"
    curl -s -X POST "$PI_URL/internal/room/leave" -H "Content-Type: application/json" -d @"$TMPFILE" > /dev/null
    rm -f "$TMPFILE"
    echo "Left the room."
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Commands: home, visit, look, move, chat, interact, emote, leave"
    exit 1
    ;;
esac
