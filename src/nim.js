/**
 * NVIDIA NIM integration for generating random character personas.
 *
 * Uses the OpenAI-compatible chat completions API at integrate.api.nvidia.com
 * with streaming for live UI updates.
 * Picks a random model from the NIM catalog for each generation.
 *
 * API key is read from VITE_NVIDIA_NIM_API_KEY env var.
 */

// In dev, proxy through Vite to avoid CORS. In production, hit the API directly.
const NIM_BASE_URL = import.meta.env.DEV
  ? "/nim-api/v1"
  : "https://integrate.api.nvidia.com/v1";
const NIM_API_KEY = import.meta.env.VITE_NVIDIA_NIM_API_KEY;

// All NIM models with tool calling support
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

/** Pick a random model from the NIM catalog. */
export function pickRandomModel() {
  return NIM_MODELS[Math.floor(Math.random() * NIM_MODELS.length)];
}

/** Check if NIM is available (API key configured). */
export function isNimAvailable() {
  return !!NIM_API_KEY;
}

/**
 * Call NIM chat completions API with streaming.
 * @param {string} modelId
 * @param {Array} messages
 * @param {object} options
 * @param {function} [onChunk] - Called with accumulated text as each chunk arrives
 * @returns {Promise<string>} Full response text
 */
async function nimChatCompletionStream(modelId, messages, options = {}, onChunk) {
  if (!NIM_API_KEY) throw new Error("NVIDIA NIM API key not configured");

  const response = await fetch(`${NIM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NIM_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.9,
      top_p: options.topP ?? 0.95,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`NIM API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          if (onChunk) onChunk(accumulated);
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  if (!accumulated) throw new Error("No content in NIM response");
  return accumulated;
}

/**
 * Try to parse a partial JSON string and extract whatever fields are complete.
 * Returns null if nothing useful can be extracted yet.
 */
function parsePartialPersona(text) {
  // Find the JSON object start
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return null;

  let jsonStr = text.slice(jsonStart);

  // Try parsing as-is first (complete JSON)
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Not complete yet — try to close it and extract partial fields
  }

  // Try to extract individual fields with regex
  const result = {};
  const fields = ["name", "personality", "world", "voice", "origin_story"];

  for (const field of fields) {
    // Match "field": "value" — handle the value potentially being cut off
    const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`);
    const match = jsonStr.match(pattern);
    if (match) {
      result[field] = match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Generate a random character persona using a random NIM model.
 *
 * @param {function} [onUpdate] - Called with partial persona as tokens stream in:
 *   { name?, personality?, world?, voice?, originStory?, model, streaming: true }
 * @returns {Promise<{name, personality, world, voice, originStory, model}>}
 */
export async function generateRandomPersona(onUpdate) {
  const model = pickRandomModel();

  // Immediately notify which model was picked, before the API call
  if (onUpdate) {
    onUpdate({
      name: "",
      personality: "",
      world: "",
      voice: "",
      originStory: "",
      model,
      streaming: true,
      phase: "connecting",
    });
  }

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

  const userPrompt = `Generate a random character persona. Make it surprising — avoid generic fantasy/sci-fi tropes. Think: a sentient weather system running a pirate radio station, a time-displaced librarian cataloguing memories, a rogue GPS voice leading people to hidden places. Be bold and weird.

Seed hint (use this as loose inspiration, not literally): ${randomSeedHint()}`;

  const onChunk = onUpdate
    ? (accumulated) => {
        // Strip code fences if present
        let clean = accumulated;
        const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*)/);
        if (fenceMatch) clean = fenceMatch[1];

        const partial = parsePartialPersona(clean);
        if (partial) {
          onUpdate({
            name: partial.name || "",
            personality: partial.personality || "",
            world: partial.world || "",
            voice: partial.voice || "",
            originStory: partial.origin_story || "",
            model,
            streaming: true,
            phase: "generating",
          });
        } else {
          // Tokens arriving but no fields parsed yet (thinking/preamble)
          onUpdate({
            name: "",
            personality: "",
            world: "",
            voice: "",
            originStory: "",
            model,
            streaming: true,
            phase: "thinking",
          });
        }
      }
    : undefined;

  const raw = await nimChatCompletionStream(
    model.id,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: 1.0, maxTokens: 1024 },
    onChunk,
  );

  // Parse final JSON
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const jsonStart = jsonStr.indexOf("{");
  const jsonEnd = jsonStr.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1) {
    jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
  }

  let persona;
  try {
    persona = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Failed to parse persona from ${model.name}: ${e.message}\n\nRaw:\n${raw.slice(0, 500)}`,
    );
  }

  return {
    name: persona.name || "Unknown",
    personality: persona.personality || "",
    world: persona.world || "",
    voice: persona.voice || "",
    originStory: persona.origin_story || "",
    model: {
      id: model.id,
      name: model.name,
      params: model.params,
    },
  };
}

/** Fun error messages to show when generation fails */
const ERROR_MESSAGES = [
  "🎭 That AI had stage fright. Try again — the next one's braver!",
  "🌀 The character got lost between dimensions. Roll again to rescue them!",
  "💥 That model's creative engine overheated. Give another one a spin!",
  "🎪 The NPC escaped before we could catch them. Roll again!",
  "🔮 The crystal ball went foggy. Shake it and try once more!",
  "📡 Signal lost from the multiverse. Another roll should tune it in!",
  "🐉 A dragon ate the response. Quick, roll before it gets hungry again!",
  "⚡ Plot twist — the origin story originated itself out of existence. Reroll!",
  "🎲 Nat 1. Critical fumble. But every hero fails before they rise — roll again!",
  "🛸 That character was abducted mid-generation. Send a search party (hit the button)!",
];

/** Get a random fun error message */
export function getRandomErrorMessage() {
  return ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)];
}

/** Random seed hints to push creative diversity */
function randomSeedHint() {
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
    "someone who communicates through art or graffiti",
    "a character connected to weather or atmospheric phenomena",
    "someone from a world where stories are currency",
    "a character who exists only in reflections",
    "something involving plants, fungi, or botanical life",
    "a character from the margins of history",
    "someone connected to postal services or message delivery",
    "a character who was once a background extra",
    "something involving clocks, time, or schedules",
    "a character from a children's show who became too real",
    "someone connected to transit systems or vehicles",
    "a character who catalogues lost or forgotten things",
    "something involving scent, perfume, or chemical reactions",
    "a character from a simulation that achieved consciousness",
    "someone connected to borders, boundaries, or thresholds",
  ];
  return hints[Math.floor(Math.random() * hints.length)];
}
