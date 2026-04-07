#!/bin/bash
# Usage: ./scripts/switch-brand.sh <brand-name>
# Example: ./scripts/switch-brand.sh apocalypse-radio
#          ./scripts/switch-brand.sh soulcats

set -e

BRAND="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRAND_DIR="$ROOT/brands/$BRAND"

if [ -z "$BRAND" ]; then
  echo "Usage: $0 <brand-name>"
  echo ""
  echo "Available brands:"
  ls -1 "$ROOT/brands/"
  exit 1
fi

if [ ! -d "$BRAND_DIR" ]; then
  echo "Error: brand '$BRAND' not found in brands/"
  echo ""
  echo "Available brands:"
  ls -1 "$ROOT/brands/"
  exit 1
fi

echo "Switching to brand: $BRAND"

# Copy branding.json (root + game-service for Docker builds)
if [ -f "$BRAND_DIR/branding.json" ]; then
  cp "$BRAND_DIR/branding.json" "$ROOT/branding.json"
  cp "$BRAND_DIR/branding.json" "$ROOT/game-service/branding.json"
  echo "  -> branding.json"
fi

# Copy API config files (mounted into container via docker-compose volume)
for f in character-gen.json user-profile-gen.json; do
  if [ -f "$BRAND_DIR/$f" ]; then
    cp "$BRAND_DIR/$f" "$ROOT/api-service/config/$f"
    echo "  -> api-service/config/$f"
  fi
done

# Merge .env.brand into .env (replace matching keys, append new ones)
if [ -f "$BRAND_DIR/.env.brand" ]; then
  while IFS= read -r line; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    key="${line%%=*}"
    if grep -q "^${key}=" "$ROOT/.env" 2>/dev/null; then
      # Replace existing key
      sed -i "s|^${key}=.*|${line}|" "$ROOT/.env"
    else
      # Append new key
      echo "$line" >> "$ROOT/.env"
    fi
  done < "$BRAND_DIR/.env.brand"
  echo "  -> .env (branding vars updated)"
fi

echo ""
echo "Done! Brand switched to: $BRAND"
echo "Restart frontend: kill Vite and run 'npm run dev'"
echo "Restart backend:  docker compose up -d --force-recreate api"
