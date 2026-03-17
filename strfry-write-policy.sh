#!/bin/sh
# strfry write policy plugin
# Reads allowed pubkeys from /app/allowed-pubkeys.txt (one per line)
# If the file doesn't exist, allow all events (open relay)

ALLOWED_FILE="/app/allowed-pubkeys.txt"

while read -r line; do
  if [ ! -f "$ALLOWED_FILE" ]; then
    # No whitelist file = open relay
    echo '{"action":"accept"}'
    continue
  fi

  PUBKEY=$(echo "$line" | jq -r '.event.pubkey // empty' 2>/dev/null)

  if [ -z "$PUBKEY" ]; then
    echo '{"action":"accept"}'
    continue
  fi

  if grep -qF "$PUBKEY" "$ALLOWED_FILE" 2>/dev/null; then
    echo '{"action":"accept"}'
  else
    echo '{"action":"reject","msg":"pubkey not allowed on this relay"}'
  fi
done
