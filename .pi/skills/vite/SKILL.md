---
name: vite
description: Start or stop the Vite dev server for npc-no-more. Use /vite to toggle, /vite start to start, /vite stop to stop, /vite status to check.
---

# Vite Dev Server

Manage the Vite dev server for the npc-no-more project.

## Usage

Determine the action from the user's input:
- **start** (or no argument, and server is not running): Start the server
- **stop** (or no argument, and server is running): Stop the server
- **status**: Check if server is running

## Check Status

```bash
lsof -i :5173 -t 2>/dev/null | head -1 | xargs -r ps -p > /dev/null 2>&1 && echo "RUNNING (PID: $(lsof -i :5173 -t 2>/dev/null | head -1))" || echo "STOPPED"
```

## Start Server

Only start if not already running. Write a starter script to /tmp, run it with nohup, and verify:

```bash
if lsof -i :5173 -t > /dev/null 2>&1; then echo "Already running at http://localhost:5173/npc-no-more/"; exit 0; fi
rm -rf /tmp/vite-cache-npc
cat > /tmp/start-vite.sh << 'EOF'
#!/bin/bash
cd /home/paul/projects/npc-no-more
exec node ./node_modules/.bin/vite --host > /tmp/npc-vite.log 2>&1
EOF
chmod +x /tmp/start-vite.sh
nohup /tmp/start-vite.sh > /dev/null 2>&1 &
echo "PID: $!"
sleep 3
if lsof -i :5173 -t > /dev/null 2>&1; then echo "✅ Vite running at http://localhost:5173/npc-no-more/"; else echo "❌ Failed to start:"; cat /tmp/npc-vite.log; fi
```

## Stop Server

Kill whatever is listening on port 5173:

```bash
PIDS=$(lsof -i :5173 -t 2>/dev/null)
if [ -z "$PIDS" ]; then echo "Already stopped"; else kill $PIDS 2>/dev/null; sleep 1; echo "✅ Stopped"; fi
```

## Toggle (no argument)

Check status first. If running, stop it. If stopped, start it.
