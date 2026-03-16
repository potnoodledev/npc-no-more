import express from "express";
import cors from "cors";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3456;

// ── API Keys ──
const NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

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

// ── Gemini ──
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  console.log("Gemini API configured");
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

// ── Health ──
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    nim: !!NIM_API_KEY,
    gemini: !!GEMINI_API_KEY,
    s3: !!s3,
    bucket: S3_BUCKET || null,
  });
});

// ══════════════════════════════════════
//  NIM: Character persona generation (streaming)
// ══════════════════════════════════════

app.post("/nim/generate", async (req, res) => {
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

// ══════════════════════════════════════
//  Gemini: Image generation
// ══════════════════════════════════════

app.post("/generate/avatar", async (req, res) => {
  if (!genAI) return res.status(503).json({ error: "Gemini API not configured" });
  if (!s3) return res.status(503).json({ error: "S3 storage not configured" });

  const { name, personality, world } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });
    const prompt = `Generate a stylized portrait avatar for a fictional character.
Name: ${name}
Personality: ${personality || "mysterious"}
World: ${world || "unknown"}
Style: Digital art portrait, square aspect ratio, suitable as a social media profile picture. Bold colors, distinctive features, no text.`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    const response = result.response;
    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

    if (!imagePart) {
      return res.status(500).json({ error: "No image generated" });
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const ext = mimeType.includes("jpeg") ? "jpg" : "png";

    const uploaded = await uploadImage(imageBuffer, mimeType, ext);
    res.json({ url: uploaded.url, id: uploaded.id });
  } catch (err) {
    console.error("Avatar generation error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/generate/post-image", async (req, res) => {
  if (!genAI) return res.status(503).json({ error: "Gemini API not configured" });
  if (!s3) return res.status(503).json({ error: "S3 storage not configured" });

  const { prompt, character } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-image" });
    const fullPrompt = character
      ? `Create an image for a social media post by "${character.name}" (${character.personality || ""}). The post says: "${prompt}". Style: evocative, atmospheric, no text overlays.`
      : `Create an image: ${prompt}. Style: evocative, atmospheric, no text overlays.`;

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    const response = result.response;
    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

    if (!imagePart) {
      return res.status(500).json({ error: "No image generated" });
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    const mimeType = imagePart.inlineData.mimeType || "image/png";
    const ext = mimeType.includes("jpeg") ? "jpg" : "png";

    const uploaded = await uploadImage(imageBuffer, mimeType, ext);
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
  console.log(`  Gemini: ${GEMINI_API_KEY ? "configured" : "NOT configured"}`);
  console.log(`  S3: ${s3 ? `configured (${S3_BUCKET})` : "NOT configured"}`);
});
