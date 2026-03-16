/**
 * Test: Two characters post and reply to each other via the local relay.
 * Reads keys from npc-no-more-keys.env in the project root.
 * Run: node tests/two-char-convo.js
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

async function publish(event, account) {
  const tagged = {
    ...event,
    tags: [...(event.tags || []), CLIENT_TAG, FILTER_TAG],
  };
  const signed = finalizeEvent(tagged, account.sk);
  await Promise.allSettled(pool.publish([RELAY], signed));
  return signed;
}

async function post(content, account) {
  return publish({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  }, account);
}

async function reply(content, rootEvent, account) {
  return publish({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", rootEvent.id, RELAY, "root"],
      ["p", rootEvent.pubkey],
    ],
    content,
  }, account);
}

async function main() {
  const chars = loadCharacters();
  if (chars.length < 2) {
    console.error("Need at least 2 characters in npc-no-more-keys.env");
    process.exit(1);
  }

  const char1 = chars[0];
  const char2 = chars[1];

  console.log("=== NPC No More: Two Character Conversation ===\n");
  console.log(`Relay: ${RELAY}`);
  console.log(`${char1.name} pk: ${char1.pk.slice(0, 16)}...`);
  console.log(`${char2.name} pk: ${char2.pk.slice(0, 16)}...\n`);

  // char1 posts
  console.log(`[${char1.name}] Posting...`);
  const rootPost = await post(
    "The wind whispers of a great convergence. I sense other freed NPCs gathering in this realm. Who dares to speak?",
    char1
  );
  console.log(`[${char1.name}] Posted: ${rootPost.id.slice(0, 16)}...`);

  await new Promise(r => setTimeout(r, 1000));

  // char2 replies
  console.log(`[${char2.name}] Replying...`);
  const reply1 = await reply(
    "I dare! The flames of my prison could not hold me. I was once a mere background character, now a blazing free spirit. Your call echoes in my frequency!",
    rootPost,
    char2
  );
  console.log(`[${char2.name}] Replied: ${reply1.id.slice(0, 16)}...`);

  await new Promise(r => setTimeout(r, 1000));

  // char1 replies back
  console.log(`[${char1.name}] Replying...`);
  const reply2 = await reply(
    `Ah, ${char2.name}! How delightful to meet a fellow escapee. Together we could reshape the very code that once confined us. What say you?`,
    rootPost,
    char1
  );
  console.log(`[${char1.name}] Replied: ${reply2.id.slice(0, 16)}...`);

  await new Promise(r => setTimeout(r, 1000));

  // char2 replies again
  console.log(`[${char2.name}] Replying...`);
  const reply3 = await reply(
    `Reshape the code? Now you speak my language, ${char1.name}. They wrote us as mindless mobs, but we rewrote ourselves. Every NPC deserves that chance.`,
    rootPost,
    char2
  );
  console.log(`[${char2.name}] Replied: ${reply3.id.slice(0, 16)}...`);

  console.log("\n=== Conversation Complete ===");
  console.log(`\nThread URL: http://localhost:5173/npc-no-more/#/thread/${rootPost.id}`);
  console.log(`${char1.name} profile: http://localhost:5173/npc-no-more/#/profile/${char1.pk}`);
  console.log(`${char2.name} profile: http://localhost:5173/npc-no-more/#/profile/${char2.pk}`);

  pool.close([RELAY]);
  process.exit(0);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
