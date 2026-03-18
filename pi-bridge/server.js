import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync, createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { fetchProfile, closePool } from "./profile.js";
import { buildSystemPrompt } from "./prompt-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3457;
const PI_BIN = process.env.PI_BIN || "pi";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const API_URL = process.env.API_URL || "http://localhost:3456";

// ── Auth — delegate to api-service ──

async function verifyViaApi(authHeaderValue) {
  if (!authHeaderValue) return null;
  try {
    const res = await fetch(`${API_URL}/admin/auth`, {
      headers: { authorization: authHeaderValue },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const base64 = authHeaderValue.slice(6);
      const event = JSON.parse(atob(base64));
      console.log(`[auth] Delegation failed: ${res.status} ${body} (pubkey=${event.pubkey?.slice(0, 16)}...)`);
      return null;
    }
    const data = await res.json();
    // api-service returns { admin, whitelist } — if we got 200, the pubkey is authorized
    // Extract pubkey from the auth event
    const base64 = authHeaderValue.slice(6);
    const event = JSON.parse(atob(base64));
    return { pubkey: event.pubkey, isAdmin: event.pubkey === data.admin };
  } catch (err) {
    console.log(`[auth] Delegation error: ${err.message}`);
    return null;
  }
}

app.use(async (req, res, next) => {
  if (req.path === "/health") return next();
  const auth = await verifyViaApi(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: "unauthorized — valid Nostr signature required" });
  }
  req.pubkey = auth.pubkey;
  req.isAdmin = auth.isAdmin;
  next();
});

// ── Pre-configure pi with NIM models ──

function setupPiConfig() {
  const piDir = join(homedir(), ".pi", "agent");
  mkdirSync(piDir, { recursive: true });

  const modelsPath = join(piDir, "models.json");
  const nimModelsRaw = JSON.parse(readFileSync(join(__dirname, "nim-models.json"), "utf-8"));

  const nimModelsAll = nimModelsRaw
    .filter((m) => m.nim_tool_calling)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const parts = m.id.split("/");
      const rawName = parts[parts.length - 1]
        .replace(/-instruct.*$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const isThinking = m.id.includes("thinking");
      return {
        id: m.id,
        name: rawName,
        ...(isThinking ? { reasoning: true } : {}),
        contextWindow: 131072,
        maxTokens: isThinking ? 16384 : 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        _totalParams: m.total_params_b,
        _activeParams: m.active_params_b,
        _arch: m.architecture,
      };
    });

  const seen = new Map();
  for (const m of nimModelsAll) seen.set(m.name, m);
  const nimModels = [...seen.values()].sort((a, b) => {
    const sizeA = a._activeParams || a._totalParams || 0;
    const sizeB = b._activeParams || b._totalParams || 0;
    if (sizeA !== sizeB) return sizeA - sizeB;
    return a.name.localeCompare(b.name);
  });

  const modelsForPi = nimModels.map(({ _totalParams, _activeParams, _arch, ...rest }) => rest);
  const modelsConfig = {
    providers: {
      "nvidia-nim": {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: NVIDIA_NIM_API_KEY,
        api: "openai-completions",
        models: modelsForPi,
      },
    },
  };
  writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2));
  console.log(`Wrote ${nimModels.length} NIM models to ${modelsPath}`);

  global.__modelMeta = Object.fromEntries(
    nimModels.map((m) => [m.id, { totalParams: m._totalParams, activeParams: m._activeParams, arch: m._arch }])
  );

  mkdirSync(WORKSPACE, { recursive: true });
}

// ── Character Workspace ──

function getCharDir(pubkeyHex) {
  return join(WORKSPACE, "characters", pubkeyHex);
}

const SKILL_TEMPLATES_DIR = join(__dirname, "skill-templates");

function ensureCharWorkspace(pubkeyHex) {
  const charDir = getCharDir(pubkeyHex);
  mkdirSync(join(charDir, ".pi", "skills"), { recursive: true });
  mkdirSync(join(charDir, ".pi", "prompts"), { recursive: true });

  // Create default CLAUDE.md if it doesn't exist (write-once)
  const claudePath = join(charDir, ".pi", "CLAUDE.md");
  if (!existsSync(claudePath)) {
    writeFileSync(claudePath, `# Character Workspace

This is your personal workspace. The pi agent can read and write files here.

## Notes
- Your skills are in .pi/skills/
- Your prompt templates are in .pi/prompts/
- This file is yours to edit — it won't be overwritten.
`);
  }

  return charDir;
}

function installSkillFromTemplate(charDir, skillName) {
  const templateDir = join(SKILL_TEMPLATES_DIR, skillName);
  if (!existsSync(templateDir)) return false;
  const destDir = join(charDir, ".pi", "skills", skillName);
  mkdirSync(destDir, { recursive: true });
  cpSync(templateDir, destDir, { recursive: true });
  return true;
}

function getInstalledSkills(charDir) {
  const skillsDir = join(charDir, ".pi", "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const skillDir = join(skillsDir, d.name);
      const skillMd = join(skillDir, "SKILL.md");
      const configPath = join(skillDir, "config.json");
      let description = "";
      let config = null;
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        // Extract first non-heading, non-empty line as description
        const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        description = lines[0] || "";
      }
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
      }
      return { name: d.name, description, config };
    });
}

function getAvailableTemplates() {
  if (!existsSync(SKILL_TEMPLATES_DIR)) return [];
  return readdirSync(SKILL_TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const skillMd = join(SKILL_TEMPLATES_DIR, d.name, "SKILL.md");
      let description = "";
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        description = lines[0] || "";
      }
      return { name: d.name, description };
    });
}

function cacheProfile(pubkeyHex, profile) {
  const cachePath = join(getCharDir(pubkeyHex), "profile-cache.json");
  try {
    writeFileSync(cachePath, JSON.stringify(profile, null, 2));
  } catch {}
}

function getCachedProfile(pubkeyHex) {
  const cachePath = join(getCharDir(pubkeyHex), "profile-cache.json");
  try {
    if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch {}
  return null;
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

  start(cwd, systemPrompt) {
    const args = ["--mode", "rpc", "--cwd", cwd];
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
    console.log(`[pi:${this.sessionId}] Started in ${cwd}`);
  }

  send(command) {
    if (!this.process || !this.ready) throw new Error("Pi process not running");
    this.process.stdin.write(JSON.stringify(command) + "\n");
  }

  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }

  kill() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

const sessions = new Map();

function restartSession(pubkeyHex) {
  const sessionId = pubkeyHex.slice(0, 16);
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    existing.kill();
    sessions.delete(sessionId);
    console.log(`[session] Killed session ${sessionId} for skill change — will restart on next WS connect`);
  }
}

async function getOrCreateSession(pubkeyHex) {
  const sessionId = pubkeyHex.slice(0, 16);

  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.ready) return existing;
    existing.kill();
  }

  // Ensure workspace exists
  const charDir = ensureCharWorkspace(pubkeyHex);

  // Fetch profile from relay
  let profile = await fetchProfile(RELAY_URL, pubkeyHex);
  if (profile) {
    cacheProfile(pubkeyHex, profile);
  } else {
    profile = getCachedProfile(pubkeyHex);
    if (profile) console.log(`[session] Using cached profile for ${pubkeyHex.slice(0, 12)}...`);
  }

  // Build system prompt from NIP-01 profile + installed skills
  const systemPrompt = buildSystemPrompt(profile, pubkeyHex, charDir);

  const rpc = new PiRpcProcess(sessionId);
  rpc.start(charDir, systemPrompt);
  sessions.set(sessionId, rpc);
  return rpc;
}

// ── HTTP Endpoints ──

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    nim: !!NVIDIA_NIM_API_KEY,
    relay: RELAY_URL,
    activeSessions: sessions.size,
  });
});

app.get("/models-meta", (req, res) => {
  res.json(global.__modelMeta || {});
});

app.get("/sessions", (req, res) => {
  res.json({ sessions: [...sessions.keys()] });
});

// Character workspace info
app.get("/characters/:pubkey/workspace", (req, res) => {
  const charDir = getCharDir(req.params.pubkey);
  if (!existsSync(charDir)) return res.json({ exists: false });

  const skillsDir = join(charDir, ".pi", "skills");
  const promptsDir = join(charDir, ".pi", "prompts");
  const claudePath = join(charDir, ".pi", "CLAUDE.md");
  const profileCache = getCachedProfile(req.params.pubkey);

  const skills = getInstalledSkills(charDir);
  const prompts = existsSync(promptsDir)
    ? readdirSync(promptsDir).filter((f) => f.endsWith(".md"))
    : [];

  res.json({
    exists: true,
    skills,
    prompts,
    hasClaudeMd: existsSync(claudePath),
    profile: profileCache,
  });
});

// Skill templates — available for installation
app.get("/skill-templates", (req, res) => {
  res.json({ templates: getAvailableTemplates() });
});

// Install a skill from template or custom content
app.post("/characters/:pubkey/skills", (req, res) => {
  const charDir = ensureCharWorkspace(req.params.pubkey);
  const { name, template, skillMd, config, files } = req.body;

  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Skill name must be lowercase alphanumeric with dashes" });
  }

  const skillDir = join(charDir, ".pi", "skills", name);

  if (template) {
    // Install from template
    if (!installSkillFromTemplate(charDir, template)) {
      return res.status(404).json({ error: `Template "${template}" not found` });
    }
  } else {
    // Install from provided content
    mkdirSync(skillDir, { recursive: true });
    if (skillMd) {
      writeFileSync(join(skillDir, "SKILL.md"), skillMd);
    }
  }

  // Write config if provided
  if (config) {
    writeFileSync(join(skillDir, "config.json"), JSON.stringify(config, null, 2));
  }

  // Write additional files (e.g., scripts)
  if (files && typeof files === "object") {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = join(skillDir, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }

  // Kill existing session so it restarts with updated skills in system prompt
  restartSession(req.params.pubkey);

  res.json({ ok: true, skill: name });
});

// Read a specific skill
app.get("/characters/:pubkey/skills/:skillName", (req, res) => {
  const charDir = getCharDir(req.params.pubkey);
  const skillDir = join(charDir, ".pi", "skills", req.params.skillName);

  if (!existsSync(skillDir)) {
    return res.status(404).json({ error: "Skill not found" });
  }

  const skillMd = join(skillDir, "SKILL.md");
  const configPath = join(skillDir, "config.json");
  const result = { name: req.params.skillName, skillMd: "", config: null, files: [] };

  if (existsSync(skillMd)) result.skillMd = readFileSync(skillMd, "utf-8");
  if (existsSync(configPath)) {
    try { result.config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  }

  // List files in skill directory
  function listFiles(dir, prefix = "") {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) listFiles(join(dir, entry.name), rel);
      else result.files.push(rel);
    }
  }
  listFiles(skillDir);

  res.json(result);
});

// Delete a skill
app.delete("/characters/:pubkey/skills/:skillName", (req, res) => {
  const charDir = getCharDir(req.params.pubkey);
  const skillDir = join(charDir, ".pi", "skills", req.params.skillName);

  console.log(`[skill] DELETE ${req.params.skillName} for ${req.params.pubkey.slice(0, 16)}... (path: ${skillDir}, exists: ${existsSync(skillDir)})`);

  if (!existsSync(skillDir)) {
    return res.status(404).json({ error: "Skill not found" });
  }

  rmSync(skillDir, { recursive: true, force: true });
  console.log(`[skill] Removed ${skillDir}, exists after: ${existsSync(skillDir)}`);

  // Kill existing session so it restarts with updated skills in system prompt
  restartSession(req.params.pubkey);

  res.json({ ok: true, removed: req.params.skillName });
});

// Serve audio files from character workspaces
app.get("/characters/:pubkey/audio/*", (req, res) => {
  const charDir = getCharDir(req.params.pubkey);
  const filePath = join(charDir, "audio", req.params[0]);
  // Prevent path traversal
  if (!filePath.startsWith(join(charDir, "audio"))) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: "not found" });
  }
  const ext = filePath.split(".").pop().toLowerCase();
  const mimeTypes = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac" };
  res.setHeader("Content-Type", mimeTypes[ext] || "application/octet-stream");
  createReadStream(filePath).pipe(res);
});

// ── WebSocket Server ──

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pubkeyHex = url.searchParams.get("pubkey") || "";

  if (!pubkeyHex) {
    ws.send(JSON.stringify({ type: "error", error: "pubkey parameter required" }));
    ws.close();
    return;
  }

  // Wait for auth message before processing commands
  let authenticated = false;
  let rpc = null;

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // First message must be auth
      if (!authenticated) {
        if (msg.type === "auth" && msg.event) {
          const authResult = await verifyViaApi("Nostr " + btoa(JSON.stringify(msg.event)));
          if (!authResult) {
            ws.send(JSON.stringify({ type: "error", error: "invalid auth signature" }));
            ws.close(1008, "unauthorized");
            return;
          }
          authenticated = true;
          console.log(`[ws] Authenticated pubkey=${pubkeyHex.slice(0, 16)}...`);

          // Now start the session
          try {
            rpc = await getOrCreateSession(pubkeyHex);
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", error: err.message }));
            ws.close();
            return;
          }

          const listener = (piMsg) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(piMsg));
          };
          rpc.addListener(listener);
          ws.on("close", () => {
            console.log(`[ws] Disconnected pubkey=${pubkeyHex.slice(0, 16)}...`);
            rpc.removeListener(listener);
          });

          // Send initial state
          ws.send(JSON.stringify({ type: "auth_ok" }));
          rpc.send({ type: "get_state" });
          return;
        }
        ws.send(JSON.stringify({ type: "error", error: "auth required — send {type: 'auth', event: <signedEvent>} first" }));
        return;
      }

      // Authenticated — forward to pi
      if (rpc) rpc.send(msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON: " + err.message }));
    }
  });
});

// ── Start ──

setupPiConfig();

server.listen(PORT, () => {
  console.log(`Pi Bridge running on port ${PORT}`);
  console.log(`  NIM: ${NVIDIA_NIM_API_KEY ? "configured" : "NOT configured"}`);
  console.log(`  Relay: ${RELAY_URL}`);
  console.log(`  Auth: Nostr NIP-98 signature verification`);
  console.log(`  Workspace: ${WORKSPACE}`);
});

process.on("SIGTERM", () => {
  closePool();
  for (const [, rpc] of sessions) rpc.kill();
  process.exit(0);
});
