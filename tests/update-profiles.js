/**
 * Generate avatars and update NIP-01 profiles for all characters.
 * Reads keys from npc-no-more-keys.env, generates avatars via api-service,
 * then publishes kind:0 metadata events to the relay.
 *
 * Run: node tests/update-profiles.js
 */

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { hexToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

global.WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = "ws://localhost:7777";
const API_URL = process.env.API_URL || "http://localhost:3456";
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://api-service-production-51aa.up.railway.app";
const CLIENT_TAG = ["client", "npc-no-more"];
const FILTER_TAG = ["l", "npc-no-more"];

// Parse npc-no-more-keys.env
function loadCharacters() {
  const envPath = resolve(__dirname, "..", "npc-no-more-keys.env");
  const content = readFileSync(envPath, "utf-8");
  const chars = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^CHARACTER_(\d+)_(\w+)=(.+)$/);
    if (!match) continue;
    const [, idx, key, value] = match;
    if (!chars[idx]) chars[idx] = {};
    chars[idx][key] = value;
  }

  return Object.values(chars).map((c) => ({
    name: c.NAME,
    sk: hexToBytes(c.SKHEX),
    skHex: c.SKHEX,
    pk: c.PK,
    npub: c.NPUB,
    nsec: c.NSEC,
  }));
}

const pool = new SimplePool();

async function publishProfile(metadata, account) {
  const event = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [CLIENT_TAG, FILTER_TAG],
    content: JSON.stringify(metadata),
  };
  const signed = finalizeEvent(event, account.sk);
  await Promise.allSettled(pool.publish([RELAY], signed));
  return signed;
}

async function generateAvatar(name, personality) {
  console.log(`  Generating avatar for ${name}...`);
  const res = await fetch(`${API_URL}/generate/avatar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, personality }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Avatar generation failed: ${err}`);
  }
  const data = await res.json();
  // Return the full public URL so it works everywhere
  return `${PUBLIC_API_URL}${data.url}`;
}

async function main() {
  const chars = loadCharacters();
  console.log(`=== Updating ${chars.length} character profiles ===\n`);
  console.log(`Relay: ${RELAY}`);
  console.log(`API: ${API_URL}\n`);

  for (const char of chars) {
    console.log(`[${char.name}]`);

    // Fetch existing profile from relay
    const existing = await pool.get([RELAY], { kinds: [0], authors: [char.pk] });
    let currentMeta = {};
    if (existing) {
      try { currentMeta = JSON.parse(existing.content); } catch {}
      console.log(`  Existing profile: ${currentMeta.display_name || currentMeta.name || "(none)"}`);
      if (currentMeta.picture) console.log(`  Existing picture: ${currentMeta.picture}`);
    } else {
      console.log(`  No existing profile found`);
    }

    // Generate avatar
    const pictureUrl = await generateAvatar(char.name, currentMeta.about || "");
    console.log(`  Avatar URL: ${pictureUrl}`);

    // Build updated metadata — keep existing fields, add/update picture
    const updatedMeta = {
      ...currentMeta,
      name: char.name,
      display_name: char.name,
      about: currentMeta.about || `${char.name} — an NPC no more.`,
      picture: pictureUrl,
    };

    // Publish
    const signed = await publishProfile(updatedMeta, char);
    console.log(`  Published kind:0 event: ${signed.id.slice(0, 16)}...`);
    console.log(`  Profile: http://localhost:5173/npc-no-more/#/profile/${char.pk}`);
    console.log();

    // Small delay between characters
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("=== All profiles updated ===");
  pool.close([RELAY]);
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
