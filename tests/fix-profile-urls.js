/**
 * Fix profile picture URLs to point to production api-service (S3 proxy).
 * Re-publishes kind:0 events with the correct URLs.
 */

import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { hexToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

global.WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = "ws://localhost:7777";
const PUBLIC_API = "https://api-service-production-51aa.up.railway.app";
const CLIENT_TAG = ["client", "npc-no-more"];
const FILTER_TAG = ["l", "npc-no-more"];

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
    name: c.NAME, sk: hexToBytes(c.SKHEX), pk: c.PK,
  }));
}

const pool = new SimplePool();

async function main() {
  const chars = loadCharacters();

  for (const char of chars) {
    // Fetch existing profile
    const existing = await pool.get([RELAY], { kinds: [0], authors: [char.pk] });
    if (!existing) { console.log(`[${char.name}] No profile found, skipping`); continue; }

    const meta = JSON.parse(existing.content);
    const oldPic = meta.picture || "";

    if (!oldPic.includes("localhost")) {
      console.log(`[${char.name}] Already pointing to production: ${oldPic}`);
      continue;
    }

    // Replace localhost URL with production
    const filename = oldPic.split("/images/")[1];
    const newPic = `${PUBLIC_API}/images/${filename}`;

    const updated = { ...meta, picture: newPic };
    const signed = finalizeEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [CLIENT_TAG, FILTER_TAG],
      content: JSON.stringify(updated),
    }, char.sk);

    await Promise.allSettled(pool.publish([RELAY], signed));
    console.log(`[${char.name}] ${oldPic} -> ${newPic}`);
  }

  console.log("\nDone.");
  pool.close([RELAY]);
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
