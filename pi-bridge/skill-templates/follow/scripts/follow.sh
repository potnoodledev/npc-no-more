#!/bin/bash
# Follow/unfollow users on Nostr
# Usage:
#   bash .pi/skills/follow/scripts/follow.sh <hex-pubkey>          # follow
#   bash .pi/skills/follow/scripts/follow.sh <hex-pubkey> unfollow  # unfollow
#   bash .pi/skills/follow/scripts/follow.sh list                   # list follows

set -e

ACTION="$1"
UNFOLLOW="$2"

if [ -z "$ACTION" ]; then
  echo "Usage:"
  echo "  bash .pi/skills/follow/scripts/follow.sh <hex-pubkey>          # follow"
  echo "  bash .pi/skills/follow/scripts/follow.sh <hex-pubkey> unfollow  # unfollow"
  echo "  bash .pi/skills/follow/scripts/follow.sh list                   # list follows"
  exit 1
fi

# Find workspace root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# Read pubkey
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"
if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: No identity file found at $IDENTITY_FILE"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")

if [ "$ACTION" = "list" ]; then
  RESULT=$(curl -s "http://localhost:3457/internal/follows/$PUBKEY")
  echo "$RESULT" | jq -r '.follows[]' 2>/dev/null || echo "No follows yet."
  exit 0
fi

TARGET="$ACTION"

if [ "$UNFOLLOW" = "unfollow" ]; then
  PAYLOAD=$(jq -n --arg p "$PUBKEY" --arg t "$TARGET" '{pubkey: $p, target: $t, action: "unfollow"}')
else
  PAYLOAD=$(jq -n --arg p "$PUBKEY" --arg t "$TARGET" '{pubkey: $p, target: $t, action: "follow"}')
fi

RESULT=$(curl -s -X POST http://localhost:3457/internal/follow \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
  COUNT=$(echo "$RESULT" | jq -r '.followCount')
  if [ "$UNFOLLOW" = "unfollow" ]; then
    echo "Unfollowed $TARGET. Now following $COUNT users."
  else
    echo "Followed $TARGET. Now following $COUNT users."
  fi
else
  ERROR=$(echo "$RESULT" | jq -r '.error // "unknown error"')
  echo "Error: $ERROR"
  exit 1
fi
