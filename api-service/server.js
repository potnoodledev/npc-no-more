import express from "express";
import cors from "cors";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const app = express();
app.use(cors());
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3456;

import { verifyNostrAuth, claimAdmin, getAuthState, addToWhitelist, removeFromWhitelist } from "./nostr-auth.js";

// ── API Keys ──
const NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";

// ── Rate Limiting ──
const rateLimits = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 30; // requests per window
const RATE_WINDOW = 60000; // 1 minute

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimits) {
    if (data.resetAt < now) rateLimits.delete(ip);
  }
}, 60000);

function checkRateLimit(ip) {
  const now = Date.now();
  let data = rateLimits.get(ip);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimits.set(ip, data);
  }
  data.count++;
  return data.count <= RATE_LIMIT;
}

// Auth + rate limit middleware for generate endpoints
function protectEndpoint(req, res, next) {
  const auth = verifyNostrAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: "unauthorized — valid Nostr signature required" });
  }
  req.pubkey = auth.pubkey;
  req.isAdmin = auth.isAdmin;
  if (!checkRateLimit(req.ip)) {
    return res.status(429).json({ error: "rate limit exceeded, try again later" });
  }
  next();
}

// ── S3 Bucket (Railway Storage Buckets are S3-compatible) ──
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
const S3_REGION = process.env.S3_REGION || "auto";

let s3 = null;
if (S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY) {
  s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  console.log(`S3 configured: ${S3_ENDPOINT} bucket=${S3_BUCKET}`);
} else {
  console.log("S3 not configured — image storage disabled");
}


// ── NIM Models ──
const NIM_MODELS = [
  { id: "meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B", params: 70 },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B", params: 70 },
  { id: "meta/llama-3.1-405b-instruct", name: "Llama 3.1 405B", params: 405 },
  { id: "meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B", params: 8 },
  { id: "mistralai/mistral-small-3.1-24b-instruct-2503", name: "Mistral Small 3.1 24B", params: 24 },
  { id: "mistralai/mistral-large-3-675b-instruct-2512", name: "Mistral Large 3 675B", params: 675 },
  { id: "mistralai/devstral-2-123b-instruct-2512", name: "Devstral 2 123B", params: 123 },
  { id: "mistralai/ministral-14b-instruct-2512", name: "Ministral 14B", params: 14 },
  { id: "qwen/qwen3.5-397b-a17b", name: "Qwen 3.5 397B", params: 17 },
  { id: "qwen/qwen3.5-122b-a10b", name: "Qwen 3.5 122B", params: 10 },
  { id: "qwen/qwen3-next-80b-a3b-instruct", name: "Qwen 3 Next 80B", params: 3 },
  { id: "qwen/qwen3-coder-480b-a35b-instruct", name: "Qwen 3 Coder 480B", params: 35 },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", name: "Nemotron Super 49B v1.5", params: 49 },
  { id: "deepseek-ai/deepseek-v3.2", name: "DeepSeek V3.2", params: 685 },
  { id: "deepseek-ai/deepseek-v3.1", name: "DeepSeek V3.1", params: 685 },
  { id: "deepseek-ai/deepseek-v3.1-terminus", name: "DeepSeek V3.1 Terminus", params: 685 },
  { id: "moonshotai/kimi-k2-instruct", name: "Kimi K2", params: 1026 },
  { id: "moonshotai/kimi-k2-instruct-0905", name: "Kimi K2 0905", params: 1026 },
  { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", params: 1026 },
  { id: "minimaxai/minimax-m2.5", name: "MiniMax M2.5", params: 228 },
  { id: "minimaxai/minimax-m2.1", name: "MiniMax M2.1", params: 228 },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", params: 120 },
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", params: 20 },
  { id: "z-ai/glm4.7", name: "GLM 4.7", params: 400 },
  { id: "z-ai/glm5", name: "GLM 5", params: 500 },
  { id: "stepfun-ai/step-3.5-flash", name: "Step 3.5 Flash", params: null },
];

// ── Relay whitelist helper ──
const RELAY_URL = process.env.RELAY_URL || "";
const RELAY_ADMIN_SECRET = process.env.RELAY_ADMIN_SECRET || "";

async function addToRelayWhitelist(pubkey, label = "") {
  if (!RELAY_URL || !RELAY_ADMIN_SECRET) return;
  const httpUrl = RELAY_URL.replace("ws://", "http://").replace("wss://", "https://");
  try {
    await fetch(`${httpUrl}/admin/pubkeys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RELAY_ADMIN_SECRET}` },
      body: JSON.stringify({ pubkey, label }),
    });
    console.log(`[relay] whitelisted ${pubkey.slice(0, 16)}... (${label})`);
  } catch (e) {
    console.error(`[relay] failed to whitelist: ${e.message}`);
  }
}

// ── Health ──
app.get("/setup-status", (req, res) => {
  const state = getAuthState();
  res.json({ adminSet: !!state.admin, adminPubkey: state.admin || null });
});

// Claim admin — only works when no admin exists yet
app.post("/claim-admin", async (req, res) => {
  const auth = verifyNostrAuth(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: "valid Nostr signature required" });
  const claimed = claimAdmin(auth.pubkey);
  if (!claimed) return res.status(409).json({ error: "admin already set" });
  await addToRelayWhitelist(auth.pubkey, "admin");
  res.json({ ok: true, adminPubkey: auth.pubkey });
});

// Admin-only: whitelist management (requires auth via protectEndpoint pattern)
app.get("/admin/auth", protectEndpoint, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: "admin only" });
  res.json(getAuthState());
});

app.post("/admin/whitelist", protectEndpoint, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: "admin only" });
  const { pubkey } = req.body;
  if (!pubkey || typeof pubkey !== "string" || pubkey.length !== 64) {
    return res.status(400).json({ error: "invalid pubkey (64 hex chars)" });
  }
  addToWhitelist(pubkey);
  await addToRelayWhitelist(pubkey, "user");
  res.json({ ok: true, whitelist: getAuthState().whitelist });
});

// Register a character pubkey on the relay (any authenticated user)
app.post("/register-pubkey", protectEndpoint, async (req, res) => {
  const { pubkey, label } = req.body;
  if (!pubkey || typeof pubkey !== "string" || pubkey.length !== 64) {
    return res.status(400).json({ error: "invalid pubkey (64 hex chars)" });
  }
  await addToRelayWhitelist(pubkey, label || "character");
  res.json({ ok: true });
});

app.delete("/admin/whitelist/:pubkey", protectEndpoint, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: "admin only" });
  removeFromWhitelist(req.params.pubkey);
  res.json({ ok: true, whitelist: getAuthState().whitelist });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    nim: !!NIM_API_KEY,
    s3: !!s3,
    bucket: S3_BUCKET || null,
  });
});

// ══════════════════════════════════════
//  NIM: Character persona generation (streaming)
// ══════════════════════════════════════

app.post("/nim/generate", protectEndpoint, async (req, res) => {
  if (!NIM_API_KEY) return res.status(503).json({ error: "NIM API key not configured" });

  const model = NIM_MODELS[Math.floor(Math.random() * NIM_MODELS.length)];

  const systemPrompt = `You are a creative character designer for an immersive social fiction platform. Your job is to generate unique, compelling character personas — NPCs who have become self-aware and are breaking free from their scripted roles.

Generate a completely random, original character. Be wildly creative — mix genres, time periods, and tropes in unexpected ways. The character should feel alive, with contradictions, secrets, and a strong voice.

Respond ONLY with valid JSON in this exact format (no markdown, no code fences, no extra text):
{
  "name": "Character's name or alias",
  "personality": "2-4 sentences describing personality, backstory, and what makes them unique. Include a secret or contradiction.",
  "world": "The setting/world they inhabit — be specific and evocative",
  "voice": "2-3 sentences describing how they speak, their verbal tics, tone, and style. Include an example phrase.",
  "origin_story": "A 3-5 sentence origin story about how they became self-aware and broke free from being an NPC. Make it dramatic and personal."
}`;

  const hints = [
    "something involving sound, music, or frequencies",
    "a character connected to food, cooking, or taste",
    "someone from between dimensions or timelines",
    "a bureaucrat or administrator who went rogue",
    "something underwater or oceanic",
    "a character obsessed with maps, routes, or navigation",
    "someone connected to dreams or sleep",
    "a character from a game within a game",
    "something involving architecture or living buildings",
    "a merchant or trader of impossible things",
  ];

  const userPrompt = `Generate a random character persona. Make it surprising — avoid generic fantasy/sci-fi tropes. Be bold and weird.

Seed hint (use as loose inspiration): ${hints[Math.floor(Math.random() * hints.length)]}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ type: "model", model })}\n\n`);

  try {
    const nimRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NIM_API_KEY}`,
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 1.0,
        top_p: 0.95,
        stream: true,
      }),
    });

    if (!nimRes.ok) {
      const errBody = await nimRes.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ type: "error", error: `NIM API error ${nimRes.status}: ${errBody.slice(0, 300)}` })}\n\n`);
      res.end();
      return;
    }

    const reader = nimRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ type: "chunk", content: delta })}\n\n`);
          }
        } catch {}
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// ══════════════════════════════════════
//  S3: Image upload helper
// ══════════════════════════════════════

async function uploadImage(buffer, contentType, extension) {
  if (!s3 || !S3_BUCKET) throw new Error("S3 not configured");

  const id = crypto.randomUUID();
  const key = `images/${id}.${extension}`;

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  // Return a URL through our own service (bucket is private)
  const url = `/images/${id}.${extension}`;
  return { id, key, url };
}

// Serve images by proxying from S3
app.get("/images/:filename", async (req, res) => {
  if (!s3 || !S3_BUCKET) return res.status(503).send("Storage not configured");

  const key = `images/${req.params.filename}`;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    res.setHeader("Content-Type", obj.ContentType || "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    obj.Body.pipe(res);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send("Not found");
    }
    console.error("Image fetch error:", err.message);
    res.status(500).send("Error fetching image");
  }
});

// Upload avatar image (base64 in JSON body)
app.post("/upload/avatar", protectEndpoint, async (req, res) => {
  try {
    const { data, contentType } = req.body;
    if (!data) return res.status(400).json({ error: "data field required (base64)" });
    const ext = (contentType || "image/png").split("/")[1] || "png";
    const buffer = Buffer.from(data, "base64");
    if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: "Image too large (max 5MB)" });
    const uploaded = await uploadImage(buffer, contentType || "image/png", ext);
    res.json({ url: uploaded.url, id: uploaded.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════
//  NVIDIA NIM: Image generation (Stable Diffusion 3)
// ══════════════════════════════════════

const NIM_IMAGE_URL = "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium";

async function nimGenerateImage(prompt) {
  if (!NIM_API_KEY) throw new Error("NIM API key not configured");

  const response = await fetch(NIM_IMAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${NIM_API_KEY}`,
      "Accept": "application/json",
    },
    body: JSON.stringify({
      prompt,
      cfg_scale: 5,
      aspect_ratio: "1:1",
      seed: Math.floor(Math.random() * 2147483647),
      steps: 50,
      negative_prompt: "text, watermark, signature, blurry, low quality, deformed",
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`NIM image API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  if (!data.image) throw new Error("No image in NIM response");

  return Buffer.from(data.image, "base64");
}

app.post("/generate/avatar", protectEndpoint, async (req, res) => {
  if (!NIM_API_KEY) return res.status(503).json({ error: "NIM API key not configured" });
  if (!s3) return res.status(503).json({ error: "S3 storage not configured" });

  const { name, personality, world } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  try {
    const prompt = `Stylized portrait avatar of a fictional character named "${name}". ${personality || "Mysterious personality"}. World: ${world || "unknown"}. Digital art, bold colors, distinctive features, square profile picture, detailed, high quality`;

    const imageBuffer = await nimGenerateImage(prompt);
    const uploaded = await uploadImage(imageBuffer, "image/png", "png");
    res.json({ url: uploaded.url, id: uploaded.id });
  } catch (err) {
    console.error("Avatar generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/generate/post-image", protectEndpoint, async (req, res) => {
  if (!NIM_API_KEY) return res.status(503).json({ error: "NIM API key not configured" });
  if (!s3) return res.status(503).json({ error: "S3 storage not configured" });

  const { prompt, character } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const fullPrompt = character
      ? `${prompt}. Art style inspired by "${character.name}" (${character.personality || ""}). Evocative, atmospheric, no text`
      : `${prompt}. Evocative, atmospheric, no text`;

    const imageBuffer = await nimGenerateImage(fullPrompt);
    const uploaded = await uploadImage(imageBuffer, "image/png", "png");
    res.json({ url: uploaded.url, id: uploaded.id });
  } catch (err) {
    console.error("Post image generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  Start
// ══════════════════════════════════════

app.listen(PORT, () => {
  console.log(`NPC API service running on port ${PORT}`);
  console.log(`  NIM: ${NIM_API_KEY ? "configured" : "NOT configured"}`);
  console.log(`  S3: ${s3 ? `configured (${S3_BUCKET})` : "NOT configured"}`);
  console.log(`  Auth: Nostr NIP-98 signature verification`);
  console.log(`  Rate limit: ${RATE_LIMIT} req/${RATE_WINDOW / 1000}s per IP`);
});
