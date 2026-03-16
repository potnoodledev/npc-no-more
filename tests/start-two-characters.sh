#!/bin/bash
# Start relay + two Vite servers for manual two-character testing.
#
# Usage:
#   ./tests/start-two-characters.sh        # start everything
#   ./tests/start-two-characters.sh stop    # stop everything
#
# Then:
#   1. Open http://localhost:5174/npc-no-more/ — set up Character 1
#   2. Open http://localhost:5175/npc-no-more/ — set up Character 2
#   3. On Character 1's page, click "✉️ Message" to DM them from Character 2's perspective
#      (or paste Character 2's npub into the URL)

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

stop_all() {
  for port in 7799 5174 5175; do
    lsof -i :"$port" -t 2>/dev/null | xargs -r kill 2>/dev/null
  done
  echo "✅ Stopped"
}

if [ "$1" = "stop" ]; then stop_all; exit 0; fi
if [ "$1" = "reset" ]; then stop_all; rm -rf /tmp/npc-two-char-relay; echo "🗑️  Data wiped"; exit 0; fi
stop_all 2>/dev/null

echo ""
echo "🎭 Starting two-character test environment"
echo "══════════════════════════════════════════"

# 1. Relay
RELAY_DATA="/tmp/npc-two-char-relay"
mkdir -p "$RELAY_DATA"
cd "$PROJECT_ROOT/relay"
ADMIN_SECRET=test-secret PORT=7799 DATA_DIR="$RELAY_DATA" ALLOWED_KINDS="0,1,3,4,5,6,7" \
  node server.js > /tmp/npc-relay.log 2>&1 &
sleep 2
if lsof -i :7799 -t > /dev/null 2>&1; then
  echo "📡 Relay on ws://localhost:7799"
else
  echo "❌ Relay failed"; cat /tmp/npc-relay.log; exit 1
fi

# 2. Clear Vite cache and start on port 5174 (Character 1)
cd "$PROJECT_ROOT"
rm -rf /tmp/vite-cache-npc
VITE_RELAY_URL=ws://localhost:7799 VITE_ADMIN_SECRET=test-secret node ./node_modules/.bin/vite --host --port 5174 > /tmp/npc-vite-1.log 2>&1 &
sleep 2
echo "🌐 Character 1 → http://localhost:5174/npc-no-more/"

# 3. Vite on port 5175 (Character 2)
VITE_RELAY_URL=ws://localhost:7799 VITE_ADMIN_SECRET=test-secret node ./node_modules/.bin/vite --host --port 5175 > /tmp/npc-vite-2.log 2>&1 &
sleep 2
echo "🌐 Character 2 → http://localhost:5175/npc-no-more/"

echo ""
echo "══════════════════════════════════════════"
echo ""
echo "  1. Open http://localhost:5174/npc-no-more/"
echo "     → Go through setup wizard, create Character 1"
echo ""
echo "  2. Open http://localhost:5175/npc-no-more/"
echo "     → Go through setup wizard, create Character 2"
echo ""
echo "  3. On either page, click '✉️ Message [name]'"
echo "     → Send a DM. Check the other browser to see it arrive."
echo ""
echo "  Stop: ./tests/start-two-characters.sh stop"
echo ""
