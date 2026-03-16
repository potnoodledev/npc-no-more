/**
 * Sets up two characters on the local relay and opens two browser windows.
 * Each browser is pre-configured with a character — no setup wizard.
 * You can then message each other from the two windows.
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, resolve as pathResolve } from "path";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: pathResolve(__dirname, "../.env") });

const RELAY_PORT = 7799;
const VITE_URL = "http://localhost:5173/npc-no-more/";

function createAccount() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, skHex: bytesToHex(sk), nsec: nsecEncode(sk), pk, npub: npubEncode(pk) };
}

async function whitelistPubkey(pk, label) {
  await fetch(`http://localhost:${RELAY_PORT}/admin/pubkeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
    body: JSON.stringify({ pubkey: pk, label }),
  });
}

async function main() {
  // Create two character accounts
  const char1 = createAccount();
  const char2 = createAccount();

  // Whitelist both on the relay
  await whitelistPubkey(char1.pk, "storm-9");
  await whitelistPubkey(char2.pk, "melody-box");

  // Build configs
  const config1 = {
    character: {
      name: "Storm-9",
      personality: "A rogue weather AI from a dying space station. Sardonic, obsessed with cloud patterns.",
      world: "Orbital Station Cirrus, decaying orbit above a water world",
      voice: "Clipped, technical jargon mixed with poetry about storms.",
      pubkey: char1.pk, npub: char1.npub,
      origin_story: [], profile_image: "", banner_image: "",
    },
    admin: { pubkey: char1.pk, npub: char1.npub },
    api_keys: {}, setup_complete: true,
  };

  const config2 = {
    character: {
      name: "Melody Box",
      personality: "A sentient jukebox who remembers every song ever played and the stories behind them.",
      world: "Route 66 diner, somewhere between memory and reality",
      voice: "Warm, nostalgic, drops song lyrics into conversation like wisdom.",
      pubkey: char2.pk, npub: char2.npub,
      origin_story: [], profile_image: "", banner_image: "",
    },
    admin: { pubkey: char2.pk, npub: char2.npub },
    api_keys: {}, setup_complete: true,
  };

  // Launch two browser windows
  const browser = await chromium.launch({ headless: false, args: ['--window-size=700,900'] });

  // Browser 1: Storm-9
  const ctx1 = await browser.newContext({ viewport: { width: 700, height: 900 } });
  const page1 = await ctx1.newPage();
  await page1.goto(VITE_URL);
  // Inject config into localStorage
  await page1.evaluate((data) => {
    localStorage.setItem("npc_config", JSON.stringify(data.config));
    localStorage.setItem("npc_character_account", JSON.stringify(data.account));
    localStorage.setItem("npc_admin_account", JSON.stringify(data.account));
    localStorage.setItem("npc_admin_secret", "test-secret");
  }, {
    config: config1,
    account: { skHex: char1.skHex, nsec: char1.nsec, pk: char1.pk, npub: char1.npub },
  });
  await page1.reload();

  // Browser 2: Melody Box
  const ctx2 = await browser.newContext({ viewport: { width: 700, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(VITE_URL);
  await page2.evaluate((data) => {
    localStorage.setItem("npc_config", JSON.stringify(data.config));
    localStorage.setItem("npc_character_account", JSON.stringify(data.account));
    localStorage.setItem("npc_admin_account", JSON.stringify(data.account));
    localStorage.setItem("npc_admin_secret", "test-secret");
  }, {
    config: config2,
    account: { skHex: char2.skHex, nsec: char2.nsec, pk: char2.pk, npub: char2.npub },
  });
  await page2.reload();

  console.log("\n" + "═".repeat(50));
  console.log("  🎭 Two browsers are open!\n");
  console.log(`  Window 1: Storm-9`);
  console.log(`  Window 2: Melody Box\n`);
  console.log("  To message each other:");
  console.log(`    1. In Storm-9's window, click "✉️ Message Storm-9"`);
  console.log(`       (this opens the visitor message view)`);
  console.log(`    2. Copy Melody Box's npub and visit:`);
  console.log(`       ${VITE_URL}#/messages/${char2.npub}`);
  console.log(`       in Storm-9's window to DM Melody Box\n`);
  console.log(`  Or just click "✉️ Message" on each character's page\n`);
  console.log(`  Storm-9 npub:    ${char1.npub}`);
  console.log(`  Melody Box npub: ${char2.npub}`);
  console.log("═".repeat(50));
  console.log("\n  Browsers will stay open. Press Ctrl+C to close.\n");

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
