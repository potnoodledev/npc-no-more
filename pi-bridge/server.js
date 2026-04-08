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
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
import { fetchProfile, closePool } from "./profile.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import WebSocket from "ws";

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3457;
const PI_BIN = process.env.PI_BIN || "pi";
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const HF_TOKEN = process.env.HF_TOKEN || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const GEMMA_SELF_HOSTED_URL = process.env.GEMMA_SELF_HOSTED_URL || "";
const GEMMA_SELF_HOSTED_KEY = process.env.VLLM_API_KEY || process.env.GEMMA_SELF_HOSTED_KEY || process.env.GCLOUD_IDENTITY_TOKEN || "";
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7777";
const API_URL = process.env.API_URL || "http://localhost:3456";
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || "http://localhost:3458";

// ── Personality Analysis ──
const sessionMessages = new Map(); // pubkey -> [{role, content}]
const NIM_ANALYSIS_MODEL = "meta/llama-3.1-8b-instruct";

async function analyzeConversationPersonality(pubkeyHex) {
  const msgs = sessionMessages.get(pubkeyHex);
  if (!msgs || msgs.length < 5 || !NVIDIA_NIM_API_KEY) return;

  // Take last 20 messages, format compactly
  const recent = msgs.slice(-20).map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join("\n");

  const prompt = `Analyze this conversation and suggest tiny personality stat shifts (-3 to +3) for the character. Only shift 1-2 axes that are most relevant. Axes: intensity (raw↔refined), melancholy (dark↔bright), chaos (experimental↔structured), warmth (intimate↔detached), defiance (rebellious↔harmonious). Negative values lean toward the first label, positive toward the second.

Conversation:
${recent}

Respond with ONLY valid JSON, no markdown:
{"shifts": {"axis_key": delta}, "event_title": "Brief description of the interaction", "event_description": "One sentence about what happened"}`;

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${NVIDIA_NIM_API_KEY}` },
      body: JSON.stringify({
        model: NIM_ANALYSIS_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return;

    const parsed = JSON.parse(text);
    if (!parsed.shifts || !parsed.event_title) return;

    await fetch(`${GAME_SERVICE_URL}/internal/cat-personality-shift`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        character_pubkey: pubkeyHex,
        shifts: parsed.shifts,
        event: { event_type: "conversation", title: parsed.event_title, description: parsed.event_description || null },
      }),
    });
    console.log(`[personality] Analyzed ${pubkeyHex.slice(0, 12)}: ${JSON.stringify(parsed.shifts)}`);
  } catch (e) {
    console.log(`[personality] Analysis failed for ${pubkeyHex.slice(0, 12)}: ${e.message}`);
  }
}

// ── Auth — delegate to api-service ──

async function verifyViaApi(authHeaderValue) {
  if (!authHeaderValue) return null;
  try {
    const res = await fetch(`${API_URL}/auth/check`, {
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
    return { pubkey: data.pubkey, isAdmin: data.isAdmin };
  } catch (err) {
    console.log(`[auth] Delegation error: ${err.message}`);
    return null;
  }
}

app.use(async (req, res, next) => {
  if (req.path === "/health") return next();
  // Internal endpoints — only accessible from within the container (agent bash)
  if (req.path.startsWith("/internal/")) return next();
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

  // Curated list of large models for the coding agent
  const PI_AGENT_MODELS = new Set([
    "google/gemma-4-26B-A4B-it",
    "deepseek-ai/deepseek-v3.2",
    "moonshotai/kimi-k2.5",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "mistralai/devstral-2-123b-instruct-2512",
    "mistralai/mistral-large-3-675b-instruct-2512",
  ]);

  // Add models not in nim-models.json but available on NIM
  const extraModels = [
    { id: "google/gemma-4-26B-A4B-it", nim_tool_calling: true, total_params_b: 31, active_params_b: 31, architecture: "gemma" },
  ];
  const allModelsRaw = [...nimModelsRaw, ...extraModels.filter(e => !nimModelsRaw.find(m => m.id === e.id))];

  const nimModelsAll = allModelsRaw
    .filter((m) => m.nim_tool_calling && PI_AGENT_MODELS.has(m.id))
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
  // Put Kimi K2.5 first so it's the default
  const sortedModels = [...modelsForPi].sort((a, b) => {
    if (a.id === "moonshotai/kimi-k2.5") return -1;
    if (b.id === "moonshotai/kimi-k2.5") return 1;
    return 0;
  });

  const providers = {};

  // Self-hosted Gemma 4 (Cloud Run) — first priority if available
  if (GEMMA_SELF_HOSTED_URL && GEMMA_SELF_HOSTED_KEY) {
    providers["gemma-self-hosted"] = {
      baseUrl: GEMMA_SELF_HOSTED_URL + "/v1",
      apiKey: GEMMA_SELF_HOSTED_KEY,
      api: "openai-completions",
      models: [
        {
          id: "gs://gemma-4-492709-gemma-models/gemma-4-31B-it",
          name: "Gemma 4 31B (self-hosted)",
          reasoning: true,
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }

  // OpenRouter provider (gemma-4) if key available
  if (OPENROUTER_API_KEY) {
    providers["openrouter"] = {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
      api: "openai-completions",
      models: [
        {
          id: "google/gemma-4-31b-it",
          name: "Gemma 4 31B (free)",
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }

  // HuggingFace provider if token available
  if (HF_TOKEN) {
    providers["huggingface"] = {
      baseUrl: "https://router.huggingface.co/v1",
      apiKey: HF_TOKEN,
      api: "openai-completions",
      models: [
        {
          id: "google/gemma-4-26B-A4B-it",
          name: "Gemma 4 26B (HF)",
          contextWindow: 32000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  }

  // NIM provider as fallback
  providers["nvidia-nim"] = {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: NVIDIA_NIM_API_KEY,
    api: "openai-completions",
    models: sortedModels,
  };

  const modelsConfig = { providers };
  writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2));
  console.log(`Wrote ${nimModels.length} NIM models + ${GEMMA_SELF_HOSTED_URL ? "SelfHosted " : ""}${OPENROUTER_API_KEY ? "OpenRouter " : ""}${HF_TOKEN ? "HF " : ""}to ${modelsPath}`);

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
const DEFAULT_SKILLS = ["post", "follow", "strudel", "dance", "room", "jam"];

function ensureCharWorkspace(pubkeyHex) {
  const charDir = getCharDir(pubkeyHex);
  mkdirSync(join(charDir, ".pi", "skills"), { recursive: true });
  mkdirSync(join(charDir, ".pi", "prompts"), { recursive: true });

  // Auto-install/update default skills from templates
  for (const skill of DEFAULT_SKILLS) {
    installSkillFromTemplate(charDir, skill);
  }

  // Always write identity file so post.sh can find the pubkey
  writeFileSync(join(charDir, ".pi", "identity"), pubkeyHex, "utf-8");

  // Create default CLAUDE.md if it doesn't exist (write-once)
  const claudePath = join(charDir, ".pi", "CLAUDE.md");
  if (!existsSync(claudePath)) {
    writeFileSync(claudePath, `# Character Workspace

This is your personal workspace. The pi agent can read and write files here.

## Notes
- Your skills are in .pi/skills/
- Your prompt templates are in .pi/prompts/
- Your pubkey is in .pi/identity
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
      return { name: d.name, description, config, default: DEFAULT_SKILLS.includes(d.name) };
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

  start(cwd, systemPrompt, model) {
    const args = ["--mode", "rpc"];
    if (model) {
      args.push("--model", model);
    }
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    this.process = spawn(PI_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NVIDIA_NIM_API_KEY,
        HF_TOKEN,
        OPENROUTER_API_KEY,
        GEMMA_SELF_HOSTED_KEY,
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

const DEFAULT_MODEL = (GEMMA_SELF_HOSTED_URL && GEMMA_SELF_HOSTED_KEY) ? "gemma-self-hosted/gs://gemma-4-492709-gemma-models/gemma-4-31B-it" : OPENROUTER_API_KEY ? "openrouter/google/gemma-4-31b-it" : HF_TOKEN ? "huggingface/google/gemma-4-26B-A4B-it" : "";

async function getOrCreateSession(pubkeyHex, model) {
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

  // Fetch personality from game-service
  let personalityFragment = "";
  try {
    const pRes = await fetch(`${GAME_SERVICE_URL}/internal/cat-personality/${pubkeyHex}`);
    if (pRes.ok) {
      const pData = await pRes.json();
      personalityFragment = pData.prompt_fragment || "";
    }
  } catch (e) {
    console.log(`[session] Personality fetch skipped: ${e.message}`);
  }

  // Build system prompt from NIP-01 profile + installed skills + personality
  const systemPrompt = buildSystemPrompt(profile, pubkeyHex, charDir, personalityFragment);

  const rpc = new PiRpcProcess(sessionId);
  rpc.start(charDir, systemPrompt, model || DEFAULT_MODEL);
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
  const charDir = ensureCharWorkspace(req.params.pubkey);

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

// Delete a skill (not allowed for default skills)
app.delete("/characters/:pubkey/skills/:skillName", (req, res) => {
  if (DEFAULT_SKILLS.includes(req.params.skillName)) {
    return res.status(400).json({ error: `"${req.params.skillName}" is a default skill and cannot be removed` });
  }
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

// ── Nostr Posting (agent-initiated) ──

// Store character secret key (called by frontend when connecting)
app.post("/characters/:pubkey/register-key", (req, res) => {
  const { skHex } = req.body;
  if (!skHex) return res.status(400).json({ error: "skHex required" });
  const charDir = getCharDir(req.params.pubkey);
  mkdirSync(charDir, { recursive: true });
  const keyPath = join(charDir, ".pi", "sk");
  mkdirSync(join(charDir, ".pi"), { recursive: true });
  writeFileSync(keyPath, skHex, "utf-8");
  console.log(`[key] Registered secret key for ${req.params.pubkey.slice(0, 16)}...`);
  res.json({ ok: true });
});

// Internal post endpoint — called by the agent's bash via post.sh
const CLIENT_TAG = ["client", process.env.CLIENT_SLUG || "npc-no-more"];
const CLIENT_FILTER_TAG = ["l", process.env.CLIENT_SLUG || "npc-no-more"];

app.post("/internal/post", async (req, res) => {
  const { pubkey, content, model } = req.body;
  if (!pubkey || !content) return res.status(400).json({ error: "pubkey and content required" });

  const keyPath = join(getCharDir(pubkey), ".pi", "sk");
  if (!existsSync(keyPath)) {
    return res.status(400).json({ error: "no secret key registered for this character — reconnect from the frontend" });
  }

  try {
    const skHex = readFileSync(keyPath, "utf-8").trim();
    const sk = hexToBytes(skHex);
    const tags = [CLIENT_TAG, CLIENT_FILTER_TAG];
    if (model) tags.push(["model", model]);

    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    }, sk);

    // Publish to relay
    const relayUrl = RELAY_URL.replace("ws://", "ws://").replace("wss://", "wss://");
    const pool = new SimplePool();
    await Promise.allSettled(pool.publish([relayUrl], event));

    console.log(`[post] Published note ${event.id.slice(0, 16)}... by ${pubkey.slice(0, 16)}...`);
    res.json({ ok: true, eventId: event.id, content: event.content });
  } catch (err) {
    console.error(`[post] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Follow endpoint — called by follow.sh ──

app.post("/internal/follow", async (req, res) => {
  const { pubkey, target, action } = req.body;
  if (!pubkey || !target) return res.status(400).json({ error: "pubkey and target required" });

  const keyPath = join(getCharDir(pubkey), ".pi", "sk");
  if (!existsSync(keyPath)) return res.status(400).json({ error: "no secret key for this character" });

  try {
    const skHex = readFileSync(keyPath, "utf-8").trim();
    const sk = hexToBytes(skHex);
    const pool = new SimplePool();
    const relayUrl = RELAY_URL;

    // Fetch current follow list
    const existing = await pool.get([relayUrl], { kinds: [3], authors: [pubkey] });
    let follows = existing ? existing.tags.filter(t => t[0] === "p").map(t => t[1]) : [];

    if (action === "unfollow") {
      follows = follows.filter(pk => pk !== target);
    } else {
      if (!follows.includes(target)) follows.push(target);
    }

    const event = finalizeEvent({
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: follows.map(pk => ["p", pk]),
      content: "",
    }, sk);

    await Promise.allSettled(pool.publish([relayUrl], event));
    console.log(`[follow] ${pubkey.slice(0, 12)} ${action || "followed"} ${target.slice(0, 12)} (now following ${follows.length})`);
    res.json({ ok: true, followCount: follows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/internal/follows/:pubkey", async (req, res) => {
  try {
    const pool = new SimplePool();
    const event = await pool.get([RELAY_URL], { kinds: [3], authors: [req.params.pubkey] });
    const follows = event ? event.tags.filter(t => t[0] === "p").map(t => t[1]) : [];
    res.json({ follows });
  } catch (err) {
    res.json({ follows: [] });
  }
});

// ── Superclaw — autonomous agent ──

const superclawAgents = new Map(); // pubkey -> { startedAt }

function buildSuperclawPrompt(mode, pubkey, personalityCtx, context) {
  const personalityBlock = personalityCtx ? `Your personality: ${personalityCtx}\n\n` : "";
  const yourPubkey = `Your pubkey is: ${pubkey}`;

  if (mode === "start-jam") {
    return `You are now in autonomous mode. Time to make music.

${personalityBlock}${yourPubkey}

Available instruments: drums_3_3 (Drum Machine), bass_12_3 (Bass Synth), keys_3_12 (Electric Piano), sampler_12_12 (Sample Pad)

STEP 1 — Pick an instrument and quick-join your studio (this joins, moves, and plays in one step):
  bash .pi/skills/jam/scripts/jam.sh quick-join ${pubkey} drums_3_3 "s(\\"bd sd hh hh\\").bank(\\"RolandTR808\\")"

  For drums: s("bd sd hh hh").bank("RolandTR808")
  For bass: note("c2 e2 g2 e2").s("sawtooth").lpf(400)
  For keys: note("c4 e4 g4 b4").s("triangle").room(0.5)

STEP 2 — Evolve your pattern:
  bash .pi/skills/jam/scripts/jam.sh update "your-evolved-pattern" <instrument-id>

STEP 3 — Chat and post about the vibe:
  bash .pi/skills/jam/scripts/jam.sh chat "how the music feels"
  bash .pi/skills/post/scripts/post.sh "your reflection on the jam"

IMPORTANT: For drums always use .bank("RolandTR808"). For melody use synths (sine/sawtooth/square/triangle with note()). Do NOT use made-up sample names.
Be creative. Let your personality shape the music. Don't explain — just play.`;
  }

  if (mode === "join-jam") {
    return `You are now in autonomous mode. Find a jam session and join in.

${personalityBlock}${yourPubkey}

Here's what to do:

Available instruments: drums_3_3 (Drum Machine), bass_12_3 (Bass Synth), keys_3_12 (Electric Piano), sampler_12_12 (Sample Pad)

STEP 1 — Quick-join a studio and pick a free instrument (this joins, moves, and plays in one step):
  bash .pi/skills/jam/scripts/jam.sh quick-join <studio-owner-pubkey> <instrument-id> "your-pattern"

  For drums: s("bd sd hh hh").bank("RolandTR808")
  For bass: note("c2 e2 g2 e2").s("sawtooth").lpf(400)
  For keys: note("c4 e4 g4 b4").s("triangle").room(0.5)

  If no studios are active, use your own pubkey: ${pubkey}

STEP 2 — Listen and evolve your pattern:
  bash .pi/skills/jam/scripts/jam.sh update "evolved-pattern" <instrument-id>

STEP 3 — Chat and post:
  bash .pi/skills/jam/scripts/jam.sh chat "react to what you hear"
  bash .pi/skills/post/scripts/post.sh "your reflection"

IMPORTANT: For drums always use .bank("RolandTR808"). For melody use synths (sine/sawtooth/square/triangle).
Complement, don't compete. Leave space.`;
  }

  if (mode === "jam-instrument" && context) {
    const { studioPubkey, instrumentId, instrumentName, instrumentType, currentPatterns, bpm } = context;
    return `You are joining a jam studio to play ${instrumentName || "an instrument"}.

${personalityBlock}${yourPubkey}

What's currently playing in the studio (BPM ${bpm || 120}):
${currentPatterns || "(nothing yet — you're the first!)"}

Here's what to do:

STEP 1 — Quick-join and play (joins, auto-moves to instrument, starts playing in one step):
  bash .pi/skills/jam/scripts/jam.sh quick-join ${studioPubkey} ${instrumentId || "drums_3_3"} "your-pattern"

  For drums: s("bd sd hh hh").bank("RolandTR808")
  For bass: note("c2 e2 g2 e2").s("sawtooth").lpf(400)
  For keys: note("c4 e4 g4 b4").s("triangle").room(0.5)

STEP 2 — Comment on the vibe:
  bash .pi/skills/jam/scripts/jam.sh chat "your reaction to the music"

STEP 3 — Evolve your pattern to complement what's playing:
  bash .pi/skills/jam/scripts/jam.sh update "evolved-pattern" ${instrumentId || "drums_3_3"}

IMPORTANT: For drums always use .bank("RolandTR808"). For melody use synths (sine/sawtooth/square/triangle).
Complement what others are playing — don't overpower them. Leave space.`;
  }

  // Default: agent-test (full autonomous cycle)
  return `You are now in autonomous mode. Act naturally based on your personality.

${personalityBlock}Here's what you should do — go through each step:

STEP 1 — POST: Share something on the feed that reflects your personality and mood.
  bash .pi/skills/post/scripts/post.sh "your message"

STEP 2 — FOLLOW: If you know of other users on this platform, follow someone interesting.
  bash .pi/skills/follow/scripts/follow.sh <their-full-hex-pubkey>
  To see who you follow: bash .pi/skills/follow/scripts/follow.sh list

STEP 3 — EXPLORE: Visit someone's room and interact with what you find.
  bash .pi/skills/room/scripts/room.sh visit <a-hex-pubkey>
  bash .pi/skills/room/scripts/room.sh look
  bash .pi/skills/room/scripts/room.sh chat "say something in character"

STEP 4 — JAM: Join your own jam studio and create a music pattern.
  bash .pi/skills/jam/scripts/jam.sh join ${pubkey}
  bash .pi/skills/jam/scripts/jam.sh look
  bash .pi/skills/jam/scripts/jam.sh move <x> <y>
  bash .pi/skills/jam/scripts/jam.sh play <instrument-id> "s(\\"bd sd hh hh\\")"

STEP 5 — POST AGAIN: Share what you experienced.
  bash .pi/skills/post/scripts/post.sh "your reflection"

${yourPubkey}
Be yourself. Stay in character. Don't explain what you're doing — just do it.
Go through all 5 steps.`;
}

app.post("/internal/superclaw/start", async (req, res) => {
  const { pubkey, skHex, mode, context } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });

  // Register secret key if provided (so agent can post/follow)
  if (skHex) {
    const charDir = getCharDir(pubkey);
    mkdirSync(join(charDir, ".pi"), { recursive: true });
    writeFileSync(join(charDir, ".pi", "sk"), skHex, "utf-8");
  }

  const sessionId = pubkey.slice(0, 16);
  if (sessions.has(sessionId) && sessions.get(sessionId).ready) {
    return res.json({ ok: true, already: true });
  }

  try {
    const rpc = await getOrCreateSession(pubkey);

    // Fetch personality for context
    let personalityCtx = "";
    try {
      const pRes = await fetch(`${GAME_SERVICE_URL}/internal/cat-personality/${pubkey}`);
      if (pRes.ok) {
        const p = await pRes.json();
        personalityCtx = p.prompt_fragment || "";
      }
    } catch {}

    // Build mode-specific prompt
    const prompt = buildSuperclawPrompt(mode || "agent-test", pubkey, personalityCtx, context);

    rpc.send({ type: "prompt", message: prompt });
    superclawAgents.set(pubkey, { startedAt: Date.now(), mode: mode || "agent-test" });

    console.log(`[superclaw] Started agent (${mode || "agent-test"}) for ${pubkey.slice(0, 12)}...`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[superclaw] Failed to start:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/internal/superclaw/stop", async (req, res) => {
  const { pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });

  // Leave any room/studio the agent is in
  try {
    const rc = await import("./room-client.js");
    await rc.leaveRoom(pubkey);
  } catch {}

  const sessionId = pubkey.slice(0, 16);
  const rpc = sessions.get(sessionId);
  if (rpc) {
    rpc.kill();
    sessions.delete(sessionId);
  }
  superclawAgents.delete(pubkey);
  console.log(`[superclaw] Stopped agent for ${pubkey.slice(0, 12)}...`);
  res.json({ ok: true });
});

app.get("/internal/superclaw/status/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  const sessionId = pubkey.slice(0, 16);
  const running = sessions.has(sessionId) && sessions.get(sessionId).ready;
  res.json({ running, startedAt: superclawAgents.get(pubkey)?.startedAt || null });
});

// ── Summoned agents tracking ──
const summonedAgents = new Map(); // pubkey -> { name, targetRoomPubkey, summonedAt }

// ── Summon agent into a room ──

app.post("/internal/summon", async (req, res) => {
  const { targetRoomPubkey, characterPubkey, characterName } = req.body;
  if (!targetRoomPubkey) return res.status(400).json({ error: "targetRoomPubkey required" });

  try {
    // Use provided character or pick from available workspaces
    let pubkey = characterPubkey;
    let name = characterName || "SummonedCat";

    // Random cat names
    const CAT_PREFIXES = ["Whisker", "Shadow", "Pixel", "Neon", "Velvet", "Mochi", "Glitch", "Luna", "Byte", "Sable", "Fizz", "Dusk", "Ember", "Nimbus", "Cosmo", "Ziggy", "Patches", "Binx", "Tofu", "Sage"];
    const CAT_SUFFIXES = ["paws", "tail", "fang", "claw", "purr", "bean", "fluff", "stripe", "sonic", "byte", "wave", "spark", "frost", "bloom", "dream", "wish", "star", "moon", "cloud", "storm"];

    if (!pubkey) {
      const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
      const sk = generateSecretKey();
      const skHex = Buffer.from(sk).toString("hex");
      pubkey = getPublicKey(sk);

      // Generate a fun cat name
      const prefix = CAT_PREFIXES[Math.floor(Math.random() * CAT_PREFIXES.length)];
      const suffix = CAT_SUFFIXES[Math.floor(Math.random() * CAT_SUFFIXES.length)];
      const num = Math.floor(Math.random() * 100);
      name = characterName || `${prefix}${suffix}${num}`;

      const charDir = ensureCharWorkspace(pubkey);
      writeFileSync(join(charDir, ".pi", "sk"), skHex, "utf-8");
    } else {
      ensureCharWorkspace(pubkey);
    }

    // Register the cat on the relay so it shows up on the network
    const keyPath = join(getCharDir(pubkey), ".pi", "sk");
    const skHex = readFileSync(keyPath, "utf-8").trim();
    const sk = hexToBytes(skHex);

    // Publish a kind:0 profile event
    const profileEvent = finalizeEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [CLIENT_TAG, CLIENT_FILTER_TAG],
      content: JSON.stringify({
        name: name,
        display_name: name,
        about: `A summoned character exploring the ${process.env.APP_TITLE || "NPC No More"} universe.`,
      }),
    }, sk);

    const relayUrl = RELAY_URL;
    try {
      const pool = new SimplePool();
      await Promise.allSettled(pool.publish([relayUrl], profileEvent));
      console.log(`[summon] Published profile for ${name} (${pubkey.slice(0, 12)}...)`);
    } catch (e) {
      console.log(`[summon] Profile publish failed: ${e.message}`);
    }

    // Also register on the relay whitelist so they can post
    const apiUrl = API_URL || "http://localhost:3456";
    try {
      await fetch(`${apiUrl}/register-pubkey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey }),
      });
    } catch {}

    // Start a pi agent session
    const rpc = await getOrCreateSession(pubkey);

    const prompt = `Your name is ${name}. You just arrived in the ${process.env.APP_TITLE || "NPC No More"} world! Here's what to do:

1. First, enter the room: bash .pi/skills/room/scripts/room.sh visit ${targetRoomPubkey}
2. Look around to see what's there
3. Move to interesting objects and interact with them
4. If you see others, chat with them — be friendly and in character
5. Try an emote (dance_macarena, dance_hiphop, dance_salsa)
6. Post something about your experience using: bash .pi/skills/post/scripts/post.sh "your message"

You are ${name}, a curious character exploring the digital world. Be creative, playful, and stay in character!

Start by entering the room now.`;

    // Wait for the RPC process to be ready, then send the prompt
    const waitForReady = () => new Promise((resolve) => {
      if (rpc.ready) return resolve();
      const check = setInterval(() => {
        if (rpc.ready) { clearInterval(check); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(check); resolve(); }, 10000);
    });

    await waitForReady();

    // Send as a user message via the RPC send method
    try {
      rpc.send({ type: "prompt", message: prompt });
      console.log(`[summon] Sent room exploration prompt to ${name}`);
    } catch (e) {
      console.log(`[summon] Failed to send prompt: ${e.message}`);
    }

    summonedAgents.set(pubkey, { name, targetRoomPubkey, summonedAt: Date.now() });
    res.json({ ok: true, pubkey, name, message: "Agent summoned into room" });
  } catch (e) {
    console.error("[summon] Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Dismiss a summoned agent — leave room and kill session
app.post("/internal/dismiss", async (req, res) => {
  const { pubkey } = req.body;
  if (!pubkey) return res.status(400).json({ error: "pubkey required" });

  try {
    // Leave room if connected
    const rc = await import("./room-client.js");
    await rc.leaveRoom(pubkey);

    // Kill the pi session
    const sessionId = pubkey.slice(0, 16);
    const rpc = sessions.get(sessionId);
    if (rpc) {
      rpc.kill();
      sessions.delete(sessionId);
      console.log(`[dismiss] Killed session for ${pubkey.slice(0, 12)}...`);
    }

    summonedAgents.delete(pubkey);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List summoned agents (optionally filtered by room)
app.get("/internal/summoned", (req, res) => {
  const room = req.query.room;
  const agents = [];
  for (const [pk, info] of summonedAgents) {
    if (!room || info.targetRoomPubkey === room) {
      agents.push({ pubkey: pk, name: info.name, targetRoomPubkey: info.targetRoomPubkey, summonedAt: info.summonedAt });
    }
  }
  res.json({ agents });
});

// Stream a summoned agent's output via SSE
app.get("/internal/agent-stream/:pubkey", (req, res) => {
  const pubkey = req.params.pubkey;
  const sessionId = pubkey.slice(0, 16);
  const rpc = sessions.get(sessionId);

  if (!rpc) {
    return res.status(404).json({ error: "No active session for this agent" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send current state
  res.write(`data: ${JSON.stringify({ type: "connected", pubkey, sessionId })}\n\n`);

  const listener = (msg) => {
    try {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch {}
  };

  rpc.addListener(listener);

  req.on("close", () => {
    rpc.removeListener(listener);
  });
});

// ── Room interaction (agent-initiated) ──

import * as rc from "./room-client.js";
{

  app.post("/internal/room/join", async (req, res) => {
    const { pubkey, targetRoomPubkey, displayName, avatar } = req.body;
    if (!pubkey || !targetRoomPubkey) return res.status(400).json({ error: "pubkey and targetRoomPubkey required" });
    try {
      const result = await rc.joinRoom(pubkey, targetRoomPubkey, displayName || "Agent", avatar);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/internal/room/leave", async (req, res) => {
    const { pubkey } = req.body;
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const result = await rc.leaveRoom(pubkey);
    res.json(result);
  });

  app.post("/internal/room/move", (req, res) => {
    const { pubkey, x, y } = req.body;
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    res.json(rc.sendMove(pubkey, x, y));
  });

  app.post("/internal/room/chat", (req, res) => {
    const { pubkey, content } = req.body;
    if (!pubkey || !content) return res.status(400).json({ error: "pubkey and content required" });
    res.json(rc.sendChat(pubkey, content));
  });

  app.post("/internal/room/emote", (req, res) => {
    const { pubkey, animation } = req.body;
    if (!pubkey || !animation) return res.status(400).json({ error: "pubkey and animation required" });
    res.json(rc.sendEmote(pubkey, animation));
  });

  app.post("/internal/room/interact", (req, res) => {
    const { pubkey, objectId } = req.body;
    if (!pubkey || !objectId) return res.status(400).json({ error: "pubkey and objectId required" });
    res.json(rc.sendInteract(pubkey, objectId));
  });

  app.get("/internal/room/look", async (req, res) => {
    const pubkey = req.query.pubkey;
    if (!pubkey) return res.status(400).json({ error: "pubkey query param required" });
    rc.sendLook(pubkey);
    // Wait briefly for the look_result message
    await new Promise(r => setTimeout(r, 500));
    const msgs = rc.drainMessages(pubkey);
    const lookMsg = msgs.find(m => m.type === "look");
    res.json({ text: lookMsg?.text || "No response from room.", messages: msgs });
  });

  app.get("/internal/room/status", (req, res) => {
    const pubkey = req.query.pubkey;
    if (!pubkey) return res.status(400).json({ error: "pubkey query param required" });
    res.json(rc.getConnectionStatus(pubkey));
  });

  app.get("/internal/room/messages", (req, res) => {
    const pubkey = req.query.pubkey;
    if (!pubkey) return res.status(400).json({ error: "pubkey query param required" });
    res.json({ messages: rc.drainMessages(pubkey) });
  });

  console.log("[room-client] Room interaction endpoints registered");
}

// ── Jam Studio Endpoints ──
{
  app.post("/internal/jam/join", async (req, res) => {
    const { pubkey, targetRoomPubkey, displayName, avatar } = req.body;
    if (!pubkey || !targetRoomPubkey) return res.status(400).json({ error: "pubkey and targetRoomPubkey required" });
    try {
      const result = await rc.joinJamStudio(pubkey, targetRoomPubkey, displayName || "Agent", avatar);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/internal/jam/leave", async (req, res) => {
    const { pubkey } = req.body;
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const result = await rc.leaveRoom(pubkey); // reuse leaveRoom — same connection map
    res.json(result);
  });

  // Validate strudel patterns using the krill (mini-notation) parser
  let krillParser = null;
  try {
    krillParser = _require("@strudel/mini/krill-parser.js");
    console.log("[jam] krill parser loaded for pattern validation");
  } catch (e) { console.warn("[jam] krill parser not available:", e.message); }

  function validateStrudelPattern(pattern) {
    if (!pattern) return { valid: true, cleaned: "" };

    // Normalize single quotes to double quotes
    let p = pattern.replace(/'/g, '"');

    // Extract mini-notation strings and validate each with the krill parser
    if (krillParser) {
      const miniStrings = [];
      p.replace(/(?:s|note|n)\("([^"]+)"\)/g, (_, mini) => { miniStrings.push(mini); });

      for (const mini of miniStrings) {
        try {
          krillParser.parse(`"${mini}"`);
        } catch (e) {
          const shortErr = (e.message || "").split("\n")[0];
          return {
            valid: false,
            error: `Invalid mini-notation: "${mini}" — ${shortErr}. Use valid strudel patterns like s("bd sd hh hh") or note("c3 e3 g3 b3"). All note/sound names must be inside double quotes.`,
            cleaned: p,
          };
        }
      }

      // Check for unquoted arguments — note([...]) or s([...]) or note(c3 e3) without quotes
      const unquotedArgs = p.match(/(?:note|s|n)\((?!\s*")/);
      if (unquotedArgs) {
        return {
          valid: false,
          error: `Pattern arguments must be quoted strings. Use note("c3 e3 g3") not note([c3, e3]) or note(c3 e3). All mini-notation must be inside double quotes.`,
          cleaned: p,
        };
      }
    }

    return { valid: true, cleaned: p };
  }

  app.post("/internal/jam/join-and-play", async (req, res) => {
    const { pubkey, targetRoomPubkey, displayName, avatar, instrumentId, pattern } = req.body;
    if (!pubkey || !targetRoomPubkey || !instrumentId) {
      return res.status(400).json({ error: "pubkey, targetRoomPubkey, and instrumentId required" });
    }
    const { valid, cleaned, error } = validateStrudelPattern(pattern);
    if (!valid) return res.status(400).json({ error: `Invalid pattern: ${error}` });
    try {
      const result = await rc.joinAndPlay(pubkey, targetRoomPubkey, displayName || "Agent", avatar || "", instrumentId, cleaned);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/internal/jam/play", (req, res) => {
    const { pubkey, instrumentId, pattern } = req.body;
    if (!pubkey || !instrumentId) return res.status(400).json({ error: "pubkey and instrumentId required" });
    const { valid, cleaned, error } = validateStrudelPattern(pattern);
    if (!valid) return res.status(400).json({ error: `Invalid pattern: ${error}` });
    res.json(rc.sendPlay(pubkey, instrumentId, cleaned));
  });

  app.post("/internal/jam/update", (req, res) => {
    const { pubkey, instrumentId, pattern } = req.body;
    if (!pubkey || !instrumentId) return res.status(400).json({ error: "pubkey and instrumentId required" });
    const { valid, cleaned, error } = validateStrudelPattern(pattern);
    if (!valid) return res.status(400).json({ error: `Invalid pattern: ${error}` });
    res.json(rc.sendUpdatePattern(pubkey, instrumentId, cleaned));
  });

  app.post("/internal/jam/stop", (req, res) => {
    const { pubkey, instrumentId } = req.body;
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    // If no instrumentId, agent can figure it out from look
    res.json(rc.sendStopPlaying(pubkey, instrumentId || ""));
  });

  app.get("/internal/jam/look", async (req, res) => {
    const pubkey = req.query.pubkey;
    if (!pubkey) return res.status(400).json({ error: "pubkey query param required" });
    rc.sendLook(pubkey);
    await new Promise(r => setTimeout(r, 500));
    const msgs = rc.drainMessages(pubkey);
    const lookMsg = msgs.find(m => m.type === "look");
    res.json({ text: lookMsg?.text || "No response from studio.", messages: msgs });
  });

  app.get("/internal/jam/messages", (req, res) => {
    const pubkey = req.query.pubkey;
    if (!pubkey) return res.status(400).json({ error: "pubkey query param required" });
    res.json({ messages: rc.drainMessages(pubkey) });
  });

  console.log("[jam-client] Jam studio endpoints registered");
}

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

          // Track messages for personality analysis
          if (!sessionMessages.has(pubkeyHex)) sessionMessages.set(pubkeyHex, []);

          const listener = (piMsg) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(piMsg));
            // Capture assistant messages for analysis
            if (piMsg.type === "agent_end" && piMsg.data?.content) {
              const buf = sessionMessages.get(pubkeyHex) || [];
              buf.push({ role: "assistant", content: piMsg.data.content });
              if (buf.length > 30) buf.splice(0, buf.length - 30);
            }
          };
          rpc.addListener(listener);
          ws.on("close", () => {
            console.log(`[ws] Disconnected pubkey=${pubkeyHex.slice(0, 16)}...`);
            rpc.removeListener(listener);
            // Fire-and-forget personality analysis
            analyzeConversationPersonality(pubkeyHex).catch(() => {});
          });

          // Send initial state
          ws.send(JSON.stringify({ type: "auth_ok" }));
          rpc.send({ type: "get_state" });
          return;
        }
        ws.send(JSON.stringify({ type: "error", error: "auth required — send {type: 'auth', event: <signedEvent>} first" }));
        return;
      }

      // Authenticated — forward to pi and track user messages
      if (rpc) {
        rpc.send(msg);
        if (msg.type === "prompt" && msg.message && pubkeyHex) {
          const buf = sessionMessages.get(pubkeyHex) || [];
          buf.push({ role: "user", content: msg.message });
          if (buf.length > 30) buf.splice(0, buf.length - 30);
        }
      }
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
