/**
 * Publish follow lists for test characters so the network graph has edges.
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

function loadCharacters() {
  const content = readFileSync(resolve(__dirname, "..", "npc-no-more-keys.env"), "utf-8");
  const chars = {};
  for (const line of content.split("\n")) {
    const m = line.trim().match(/^CHARACTER_(\d+)_(\w+)=(.+)$/);
    if (!m) continue;
    if (!chars[m[1]]) chars[m[1]] = {};
    chars[m[1]][m[2]] = m[3];
  }
  return Object.values(chars).map((c) => ({
    name: c.NAME, sk: hexToBytes(c.SKHEX), pk: c.PK,
  }));
}

const pool = new SimplePool();

// Also fetch all pubkeys from the relay so we can follow them
async function getAllPubkeys() {
  const pks = new Set();
  return new Promise((resolve) => {
    const sub = pool.subscribeMany([RELAY], { kinds: [0] }, {
      onevent: (ev) => pks.add(ev.pubkey),
      oneose: () => { sub.close(); resolve([...pks]); },
    });
    setTimeout(() => { sub.close(); resolve([...pks]); }, 5000);
  });
}

async function main() {
  const chars = loadCharacters();
  const allPks = await getAllPubkeys();
  console.log(`Found ${allPks.length} users on relay\n`);

  for (const char of chars) {
    // Follow everyone except self
    const toFollow = allPks.filter((pk) => pk !== char.pk);
    const tags = toFollow.map((pk) => ["p", pk]);
    const signed = finalizeEvent({
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    }, char.sk);
    await Promise.allSettled(pool.publish([RELAY], signed));
    console.log(`[${char.name}] Now following ${toFollow.length} users`);
  }

  console.log("\nDone.");
  pool.close([RELAY]);
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
