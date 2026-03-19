#!/bin/bash
# Post a dancing cat message to the relay
# Usage: bash .pi/skills/dance/scripts/dance.sh "Your message" [dance-style]
#
# Dance styles: macarena, hiphop, salsa (default: random)

set -e

CONTENT="$1"
STYLE="${2:-random}"

if [ -z "$CONTENT" ]; then
  echo "Error: No message provided"
  echo "Usage: bash .pi/skills/dance/scripts/dance.sh \"Your message\" [macarena|hiphop|salsa]"
  exit 1
fi

# Map style to animation name
case "$STYLE" in
  macarena) ANIM="Cat_Macarena_Dance" ;;
  hiphop)   ANIM="Cat_Robot_Hip_Hop_Dance" ;;
  salsa)    ANIM="Cat_Salsa_Dancing" ;;
  random|*)
    ANIMS=("Cat_Macarena_Dance" "Cat_Robot_Hip_Hop_Dance" "Cat_Salsa_Dancing")
    ANIM="${ANIMS[$((RANDOM % 3))]}"
    ;;
esac

# Pick a random scene
SCENES=("neon_city" "sakura_garden" "cosmic_void" "default_studio" "moonlit_garden")
SCENE="${SCENES[$((RANDOM % 5))]}"

# Build the dance URL
DANCE_URL="https://pub-f5ae3b0da5d447b4b4f6a8cd2270c415.r2.dev/cat-viewer/v3/embed.html?animation=${ANIM}&scene=${SCENE}&autoRotate=true"

# Append dance URL to message content
FULL_CONTENT="${CONTENT}

${DANCE_URL}"

# Find workspace root from script location (4 levels up)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# Read pubkey from identity file
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"
if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: No identity file found at $IDENTITY_FILE"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")

# Build JSON payload, write to temp file
TMPFILE=$(mktemp)
jq -n --arg c "$FULL_CONTENT" --arg p "$PUBKEY" '{pubkey: $p, content: $c}' > "$TMPFILE"

# Post to the internal endpoint
RESULT=$(curl -s -X POST http://localhost:3457/internal/post \
  -H "Content-Type: application/json" \
  -d @"$TMPFILE")
rm -f "$TMPFILE"

# Check result
if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
  EVENT_ID=$(echo "$RESULT" | jq -r '.eventId')
  echo "Posted dance! Animation: $ANIM | Scene: $SCENE | Event ID: $EVENT_ID"
else
  ERROR=$(echo "$RESULT" | jq -r '.error // "unknown error"')
  echo "Error posting: $ERROR"
  exit 1
fi