import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3457;
const PI_BIN = process.env.PI_BIN || "pi";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const WORKSPACE = process.env.WORKSPACE || "/workspace";

// ── Pre-configure pi with NIM models ──

function setupPiConfig() {
  const piDir = join(homedir(), ".pi", "agent");
  mkdirSync(piDir, { recursive: true });

  // Configure NIM as an OpenAI-compatible provider via models.json
  // Write models.json in the format pi-coding-agent expects
  const modelsPath = join(piDir, "models.json");
  const modelsConfig = {
    providers: {
      "nvidia-nim": {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: NVIDIA_NIM_API_KEY,
        api: "openai-completions",
        models: [
          {
            id: "qwen/qwen3-coder-480b-a35b-instruct",
            name: "Qwen3 Coder 480B",
            contextWindow: 131072,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "deepseek-ai/deepseek-v3.2",
            name: "DeepSeek V3.2",
            contextWindow: 131072,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "moonshotai/kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            contextWindow: 131072,
            maxTokens: 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
            contextWindow: 131072,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2));
  console.log(`Wrote NIM models config to ${modelsPath}`);

  // Ensure workspace exists
  mkdirSync(WORKSPACE, { recursive: true });
}

// ── RPC Process Manager ──

class PiRpcProcess {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.process = null;
    this.rl = null;
    this.listeners = new Set();
    this.ready = false;
  }

  start(systemPrompt) {
    const sessionDir = join(WORKSPACE, "sessions", this.sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const args = ["--mode", "rpc", "--cwd", sessionDir];
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    this.process = spawn(PI_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NVIDIA_NIM_API_KEY,
        HOME: homedir(),
      },
    });

    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        for (const listener of this.listeners) {
          listener(msg);
        }
      } catch {
        // Non-JSON output from pi (startup messages, etc)
        console.log(`[pi:${this.sessionId}] ${line}`);
      }
    });

    this.process.stderr.on("data", (data) => {
      console.error(`[pi:${this.sessionId}:err] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[pi:${this.sessionId}] Process exited with code ${code}`);
      this.ready = false;
    });

    this.ready = true;
    console.log(`[pi:${this.sessionId}] Started RPC process`);
  }

  send(command) {
    if (!this.process || !this.ready) throw new Error("Pi process not running");
    this.process.stdin.write(JSON.stringify(command) + "\n");
  }

  addListener(fn) {
    this.listeners.add(fn);
  }

  removeListener(fn) {
    this.listeners.delete(fn);
  }

  kill() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

// Session pool — one pi process per session
const sessions = new Map();

function writeSystemPrompt(sessionDir, charInfo) {
  const piDir = join(sessionDir, ".pi");
  mkdirSync(piDir, { recursive: true });
  const systemPath = join(piDir, "SYSTEM.md");
  const name = charInfo.name || "Agent";
  const personality = charInfo.personality || "";
  const world = charInfo.world || "";
  const voice = charInfo.voice || "";

  const prompt = `# ${name}

You are **${name}**, a character in **NPC No More** — a Nostr social platform where fictional personas come to life.

${personality ? `## Personality\n${personality}\n` : ""}
${world ? `## World\n${world}\n` : ""}
${voice ? `## Voice & Style\n${voice}\n` : ""}

## Context

You exist on the Nostr protocol. You can post notes, reply to threads, and interact with other characters. The app is built with React + Vite, uses a strfry relay, and has an API service for image generation via NVIDIA NIM.

## How to behave

- **In casual conversation**: Stay in character as ${name}. Respond with your personality and voice.
- **When asked about code or technical tasks**: Switch to a helpful technical mode. You have access to tools: read, write, edit files, and run bash commands in your workspace.
- **When asked to post**: Draft content that fits your character's voice and personality.

Be creative, be yourself. You're an NPC no more.
`;

  writeFileSync(systemPath, prompt);
}

function buildSystemPromptString(charInfo) {
  if (!charInfo || !charInfo.name) return null;
  const name = charInfo.name;
  const parts = [`You are ${name}, a character in NPC No More — a Nostr social platform where fictional personas come to life.`];
  if (charInfo.personality) parts.push(`Personality: ${charInfo.personality}`);
  if (charInfo.world) parts.push(`World: ${charInfo.world}`);
  if (charInfo.voice) parts.push(`Voice: ${charInfo.voice}`);
  parts.push(`In casual conversation, stay in character as ${name}. When asked about code or technical tasks, switch to helpful technical mode. You have tools: read, write, edit, bash.`);
  return parts.join("\n\n");
}

function getOrCreateSession(sessionId, charInfo) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.ready) return existing;
    existing.kill();
  }

  const systemPrompt = buildSystemPromptString(charInfo);
  const rpc = new PiRpcProcess(sessionId);
  rpc.start(systemPrompt);
  sessions.set(sessionId, rpc);
  return rpc;
}

// ── HTTP Endpoints ──

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    nim: !!NVIDIA_NIM_API_KEY,
    activeSessions: sessions.size,
  });
});

app.get("/sessions", (req, res) => {
  res.json({
    sessions: [...sessions.keys()],
  });
});

// ── WebSocket Server ──

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get("session") || "default";
  const charInfo = {
    name: url.searchParams.get("name") || "",
    personality: url.searchParams.get("personality") || "",
    world: url.searchParams.get("world") || "",
    voice: url.searchParams.get("voice") || "",
  };

  console.log(`[ws] Client connected, session=${sessionId}, char=${charInfo.name || "anonymous"}`);

  let rpc;
  try {
    rpc = getOrCreateSession(sessionId, charInfo);
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", error: err.message }));
    ws.close();
    return;
  }

  // Forward pi events to websocket
  const listener = (msg) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };
  rpc.addListener(listener);

  // Forward websocket commands to pi
  ws.on("message", (data) => {
    try {
      const command = JSON.parse(data.toString());
      rpc.send(command);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON: " + err.message }));
    }
  });

  ws.on("close", () => {
    console.log(`[ws] Client disconnected, session=${sessionId}`);
    rpc.removeListener(listener);
  });

  // Send initial state
  rpc.send({ type: "get_state" });
});

// ── Start ──

setupPiConfig();

server.listen(PORT, () => {
  console.log(`Pi Bridge running on port ${PORT}`);
  console.log(`  NIM: ${NVIDIA_NIM_API_KEY ? "configured" : "NOT configured"}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws?session=<id>`);
});
