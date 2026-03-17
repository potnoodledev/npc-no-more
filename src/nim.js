/**
 * NIM integration via the API service (no API keys on client).
 * Calls POST /nim/generate on the API service, which streams SSE back.
 */

const API_URL = import.meta.env.VITE_API_URL || "";
const API_KEY = import.meta.env.VITE_API_KEY || "";

function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

/** Check if NIM is available (API service configured). */
export function isNimAvailable() {
  return !!API_URL;
}

/**
 * Try to parse a partial JSON string and extract whatever fields are complete.
 */
function parsePartialPersona(text) {
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return null;

  let jsonStr = text.slice(jsonStart);

  try {
    return JSON.parse(jsonStr);
  } catch {
    // Not complete yet — try to extract partial fields
  }

  const result = {};
  const fields = ["name", "personality", "world", "voice", "origin_story"];

  for (const field of fields) {
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
 * Generate a random character persona via the API service.
 *
 * @param {function} [onUpdate] - Called with partial persona as tokens stream in
 * @returns {Promise<{name, personality, world, voice, originStory, model}>}
 */
export async function generateRandomPersona(onUpdate) {
  if (!API_URL) throw new Error("API service not configured");

  let model = { id: "unknown", name: "Unknown", params: null };

  if (onUpdate) {
    onUpdate({
      name: "", personality: "", world: "", voice: "", originStory: "",
      model, streaming: true, phase: "connecting",
    });
  }

  const response = await fetch(`${API_URL}/nim/generate`, {
    method: "POST",
    headers: apiHeaders(),
    body: "{}",
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${err.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

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

      try {
        const msg = JSON.parse(data);

        if (msg.type === "model") {
          model = msg.model;
          if (onUpdate) {
            onUpdate({
              name: "", personality: "", world: "", voice: "", originStory: "",
              model, streaming: true, phase: "connecting",
            });
          }
        }

        if (msg.type === "chunk") {
          accumulated += msg.content;

          // Strip code fences if present
          let clean = accumulated;
          const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*)/);
          if (fenceMatch) clean = fenceMatch[1];

          const partial = parsePartialPersona(clean);
          if (onUpdate) {
            if (partial) {
              onUpdate({
                name: partial.name || "",
                personality: partial.personality || "",
                world: partial.world || "",
                voice: partial.voice || "",
                originStory: partial.origin_story || "",
                model, streaming: true, phase: "generating",
              });
            } else {
              onUpdate({
                name: "", personality: "", world: "", voice: "", originStory: "",
                model, streaming: true, phase: "thinking",
              });
            }
          }
        }

        if (msg.type === "error") {
          throw new Error(msg.error);
        }
      } catch (e) {
        if (e.message && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }

  // Parse final JSON
  let jsonStr = accumulated.trim();
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
    throw new Error(`Failed to parse persona from ${model.name}: ${e.message}`);
  }

  return {
    name: persona.name || "Unknown",
    personality: persona.personality || "",
    world: persona.world || "",
    voice: persona.voice || "",
    originStory: persona.origin_story || "",
    model: { id: model.id, name: model.name, params: model.params },
  };
}

/** Fun error messages */
const ERROR_MESSAGES = [
  "That AI had stage fright. Try again!",
  "The character got lost between dimensions. Roll again!",
  "That model's creative engine overheated. Give another one a spin!",
  "The NPC escaped before we could catch them. Roll again!",
  "The crystal ball went foggy. Try once more!",
  "Signal lost from the multiverse. Another roll should tune it in!",
  "A dragon ate the response. Roll before it gets hungry again!",
  "Plot twist — the origin story originated itself out of existence. Reroll!",
  "Nat 1. Critical fumble. But every hero fails before they rise — roll again!",
  "That character was abducted mid-generation. Hit the button!",
];

export function getRandomErrorMessage() {
  return ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)];
}

/**
 * Generate an avatar image via the API service (NVIDIA NIM / Stable Diffusion 3).
 * @param {{ name: string, personality?: string, world?: string }} character
 * @returns {Promise<{ url: string, id: string }>}
 */
export async function generateAvatar(character) {
  if (!API_URL) throw new Error("API service not configured");

  const res = await fetch(`${API_URL}/generate/avatar`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      name: character.name,
      personality: character.personality || "",
      world: character.world || "",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Image generation failed: ${res.status}`);
  }

  const data = await res.json();
  // Return full URL through the API service
  return { url: `${API_URL}${data.url}`, id: data.id };
}
