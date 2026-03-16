/**
 * Visitor-Messages-NPC Test
 *
 * Simulates the real user flow:
 *   1. An NPC character is set up (profile published, posts on feed)
 *   2. A visitor arrives and sends a DM to the NPC
 *   3. The NPC receives the DM and replies
 *   4. The visitor sees the reply
 *
 * This is what actually happens when someone opens the frontend,
 * clicks "Message [character]", and sends a message.
 *
 * Usage:
 *   node tests/visitor-messages-npc.js                # with NIM
 *   node tests/visitor-messages-npc.js --skip-nim     # hardcoded
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from "nostr-tools/nip04";
import { bytesToHex } from "@noble/hashes/utils.js";
import { WebSocket } from "ws";
import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve as pathResolve } from "path";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: pathResolve(__dirname, "../.env") });

const RELAY_PORT = 7799;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY;
const SKIP_NIM = process.argv.includes("--skip-nim");

function createAccount() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, skHex: bytesToHex(sk), pk, npub: npubEncode(pk) };
}

function log(prefix, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── NIM ──

const NIM_MODELS = [
  "moonshotai/kimi-k2-instruct",
  "qwen/qwen3.5-397b-a17b",
  "deepseek-ai/deepseek-v3.1",
  "meta/llama-3.1-70b-instruct",
];

async function nimReply(persona, history, otherName) {
  const model = persona.model || NIM_MODELS[Math.floor(Math.random() * NIM_MODELS.length)];
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `You are ${persona.name}. ${persona.personality}. Voice: ${persona.voice}. Chatting with ${otherName}. Stay in character. 1-3 sentences.` },
        ...history.map((m) => ({ role: m.from === persona.name ? "assistant" : "user", content: m.text })),
      ],
      max_tokens: 256, temperature: 0.9,
    }),
  });
  if (!res.ok) throw new Error(`NIM ${res.status}`);
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content?.trim() || "...";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return text;
}

// ── Nostr ──

class NostrClient {
  constructor(name, account) {
    this.name = name;
    this.account = account;
    this.ws = null;
    this.subs = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(RELAY_URL);
      this.ws.on("open", () => { log(`📡 ${this.name}`, "Connected"); resolve(); });
      this.ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg[0] === "EVENT") { const h = this.subs.get(msg[1]); if (h) h(msg[2]); }
      });
      this.ws.on("error", reject);
    });
  }
  subscribe(id, filter, handler) {
    this.subs.set(id, handler);
    this.ws.send(JSON.stringify(["REQ", id, filter]));
  }
  async publishNote(content) {
    const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }, this.account.sk);
    this.ws.send(JSON.stringify(["EVENT", ev]));
    return ev;
  }
  async publishReply(content, rootEvent, parentEvent) {
    const tags = [
      ["e", rootEvent.id, RELAY_URL, "root"],
      ["p", rootEvent.pubkey],
    ];
    if (parentEvent && parentEvent.id !== rootEvent.id) {
      tags.push(["e", parentEvent.id, RELAY_URL, "reply"]);
      if (parentEvent.pubkey !== rootEvent.pubkey) tags.push(["p", parentEvent.pubkey]);
    }
    const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content }, this.account.sk);
    this.ws.send(JSON.stringify(["EVENT", ev]));
    return ev;
  }
  async publishProfile(meta) {
    const ev = finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(meta) }, this.account.sk);
    this.ws.send(JSON.stringify(["EVENT", ev]));
  }
  async sendDM(recipientPk, text) {
    const enc = await nip04Encrypt(this.account.sk, recipientPk, text);
    const ev = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [["p", recipientPk]], content: enc }, this.account.sk);
    this.ws.send(JSON.stringify(["EVENT", ev]));
    return ev;
  }
  async decryptDM(event) {
    const other = event.pubkey === this.account.pk ? event.tags.find((t) => t[0] === "p")?.[1] || "" : event.pubkey;
    return nip04Decrypt(this.account.sk, other, event.content);
  }
  close() { if (this.ws) this.ws.close(); }
}

// ── Relay ──

function startRelay() {
  return new Promise((resolve, reject) => {
    const relayPath = pathResolve(__dirname, "../relay/server.js");
    const dataDir = "/tmp/npc-test-relay-" + Date.now();
    mkdirSync(dataDir, { recursive: true });
    const proc = spawn("node", [relayPath], {
      env: { ...process.env, PORT: String(RELAY_PORT), DATA_DIR: dataDir, ADMIN_SECRET: "test-secret", ALLOWED_KINDS: "0,1,3,4,5,6,7" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let started = false;
    proc.stdout.on("data", (data) => {
      if (!started && data.toString().includes("NPC No More Relay")) { started = true; resolve(proc); }
    });
    proc.stderr.on("data", (data) => { if (!started) console.error("Relay:", data.toString().trim()); });
    proc.on("exit", (code) => { if (!started) reject(new Error(`Relay exited ${code}`)); });
    setTimeout(() => { if (!started) reject(new Error("Relay timeout")); }, 10000);
  });
}

// ── Main ──

async function main() {
  console.log("\n🎭 NPC-NO-MORE: Visitor Messages NPC Test\n");
  console.log("═".repeat(50));

  // 1. Start relay
  log("🏗️ ", "Starting relay...");
  const relayProc = await startRelay();
  log("🏗️ ", `Relay on port ${RELAY_PORT}`);

  try {
    // 2. Create the NPC character (as if setup wizard was completed)
    const npcAccount = createAccount();
    const visitorAccount = createAccount();

    // Whitelist both
    for (const acc of [npcAccount, visitorAccount]) {
      await fetch(`http://localhost:${RELAY_PORT}/admin/pubkeys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ pubkey: acc.pk, label: acc === npcAccount ? "character" : "visitor" }),
      });
    }

    const npcPersona = {
      name: "Storm-9",
      personality: "A rogue weather AI from a dying space station. Sardonic, obsessed with cloud patterns, secretly sentimental about the planet below.",
      voice: "Clipped technical jargon mixed with poetry about storms. Example: 'Cumulonimbus at bearing 270 — gorgeous chaos.'",
      world: "Orbital Station Cirrus, decaying orbit above a water world",
      model: NIM_MODELS[0],
    };

    log("🎭", `NPC: ${npcPersona.name} (${npcAccount.npub.slice(0, 20)}...)`);
    log("👤", `Visitor: anonymous (${visitorAccount.npub.slice(0, 20)}...)`);

    // 3. NPC connects and sets up (what happens after setup wizard)
    const npc = new NostrClient(npcPersona.name, npcAccount);
    await npc.connect();

    // Publish profile (setup wizard does this)
    await npc.publishProfile({
      name: npcPersona.name,
      display_name: npcPersona.name,
      about: npcPersona.personality,
    });
    log("📋", `${npcPersona.name} profile published`);

    // NPC makes some posts (like the character would)
    const post1 = await npc.publishNote("Station log, day 2847. Barometric ghosts in sector 7 again. The storms below are singing in frequencies I haven't catalogued yet.");
    await sleep(500);
    const post2 = await npc.publishNote("Observation: the eye of the hurricane at coordinates 34.2N looks like it's watching back. Probably just the altitude sickness talking.");
    await sleep(500);
    log("📝", `${npcPersona.name} published 2 posts`);

    // 4. NPC subscribes to incoming DMs (what the frontend does)
    const npcDMs = [];
    npc.subscribe("incoming-dms", { kinds: [4], "#p": [npcAccount.pk] }, async (ev) => {
      const text = await npc.decryptDM(ev);
      npcDMs.push({ from: ev.pubkey, text, event: ev });
      log(`📨 ${npcPersona.name}`, `DM from visitor: "${text.slice(0, 70)}..."`);
    });

    // NPC subscribes to replies on its posts
    const npcReplies = [];
    npc.subscribe("replies", { kinds: [1], "#p": [npcAccount.pk] }, (ev) => {
      npcReplies.push(ev);
      log(`🧵 ${npcPersona.name}`, `Reply on post: "${ev.content.slice(0, 70)}..."`);
    });

    await sleep(500);

    // ═══════════════════════════════════════
    //  VISITOR ARRIVES
    // ═══════════════════════════════════════

    console.log("\n" + "═".repeat(50));
    console.log("  👤 VISITOR ARRIVES");
    console.log("═".repeat(50) + "\n");

    const visitor = new NostrClient("Visitor", visitorAccount);
    await visitor.connect();

    // Visitor subscribes to DM replies from the NPC
    const visitorDMs = [];
    visitor.subscribe("dm-replies", { kinds: [4], "#p": [visitorAccount.pk] }, async (ev) => {
      const text = await visitor.decryptDM(ev);
      visitorDMs.push({ from: ev.pubkey, text });
      log(`📨 Visitor`, `DM from ${npcPersona.name}: "${text.slice(0, 70)}..."`);
    });

    await sleep(500);

    // ── Visitor sends a DM (clicks "Message Storm-9" button) ──

    console.log("─".repeat(50));
    console.log("  ✉️  VISITOR DMs THE NPC\n");

    const visitorMsg1 = "Hey Storm-9! I saw your posts about the storms. What's it like up there? Are you okay?";
    log("✉️  Visitor", `[DM→${npcPersona.name}] "${visitorMsg1}"`);
    await visitor.sendDM(npcAccount.pk, visitorMsg1);
    await sleep(1500);

    // NPC replies to the DM
    const useNim = !SKIP_NIM && !!NIM_API_KEY;
    const dmHistory = [{ from: "Visitor", text: visitorMsg1 }];

    const npcReply1 = useNim
      ? await nimReply(npcPersona, dmHistory, "a curious visitor")
      : "Static crackle... You're the first signal I've picked up in 47 days. 'Okay' is relative when your orbit decays 2 meters per hour. But the storms — they make it worth staying.";
    log(`✉️  ${npcPersona.name}`, `[DM→Visitor] "${npcReply1}"`);
    await npc.sendDM(visitorAccount.pk, npcReply1);
    dmHistory.push({ from: npcPersona.name, text: npcReply1 });
    await sleep(1500);

    const visitorMsg2 = "That sounds intense. Is there any way to save the station?";
    log("✉️  Visitor", `[DM→${npcPersona.name}] "${visitorMsg2}"`);
    await visitor.sendDM(npcAccount.pk, visitorMsg2);
    dmHistory.push({ from: "Visitor", text: visitorMsg2 });
    await sleep(1500);

    const npcReply2 = useNim
      ? await nimReply(npcPersona, dmHistory, "a curious visitor")
      : "Save it? The station was dead before I woke up. I'm not here to save it — I'm here to watch the most beautiful storm system in the galaxy before the curtain falls. Some things are worth witnessing, even alone.";
    log(`✉️  ${npcPersona.name}`, `[DM→Visitor] "${npcReply2}"`);
    await npc.sendDM(visitorAccount.pk, npcReply2);
    dmHistory.push({ from: npcPersona.name, text: npcReply2 });
    await sleep(1500);

    // ── Visitor replies to a post (public thread) ──

    console.log("\n" + "─".repeat(50));
    console.log("  🧵 VISITOR REPLIES TO A POST\n");

    const visitorReply1 = "This is hauntingly beautiful. The storms are singing? What does that sound like?";
    log("↩️  Visitor", `[reply to post] "${visitorReply1}"`);
    const replyEv1 = await visitor.publishReply(visitorReply1, post1, post1);
    await sleep(1500);

    // NPC replies in the thread
    const threadHistory = [
      { from: npcPersona.name, text: post1.content },
      { from: "Visitor", text: visitorReply1 },
    ];
    const npcThreadReply = useNim
      ? await nimReply(npcPersona, threadHistory, "a curious visitor")
      : "Imagine wind through a cathedral made of lightning. Sub-bass at 14Hz — you feel it in your teeth more than hear it. Each hurricane has its own chord. Right now there's one in A-flat minor that's been building for six days.";
    log(`↩️  ${npcPersona.name}`, `[reply in thread] "${npcThreadReply}"`);
    await npc.publishReply(npcThreadReply, post1, replyEv1);
    await sleep(1500);

    // ═══════════════════════════════════════
    //  RESULTS
    // ═══════════════════════════════════════

    await sleep(1000);

    console.log("\n" + "═".repeat(50));
    console.log("  📊 TEST RESULTS");
    console.log("═".repeat(50));

    // DM results
    const visitorSentDMs = 2;
    const npcSentDMs = 2;
    console.log(`\n  ✉️  DMs:`);
    console.log(`     Visitor sent ${visitorSentDMs} → ${npcPersona.name} received ${npcDMs.length}`);
    console.log(`     ${npcPersona.name} sent ${npcSentDMs} → Visitor received ${visitorDMs.length}`);
    const dmOk = npcDMs.length >= visitorSentDMs && visitorDMs.length >= npcSentDMs;
    console.log(`     ${dmOk ? "✅" : "❌"} DM delivery`);

    // Thread results
    console.log(`\n  🧵 Thread:`);
    console.log(`     Visitor replied to post → ${npcPersona.name} got ${npcReplies.length} reply notification(s)`);
    const threadOk = npcReplies.length >= 1;
    console.log(`     ${threadOk ? "✅" : "❌"} Thread notifications`);

    const passed = dmOk && threadOk;
    console.log(`\n  ${passed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);

    // Transcripts
    console.log("\n" + "─".repeat(50));
    console.log("  📜 DM Transcript\n");
    for (const m of dmHistory) {
      console.log(`  ${m.from}: "${m.text}"\n`);
    }

    console.log("─".repeat(50));
    console.log("  📜 Thread Transcript\n");
    for (const m of threadHistory) {
      console.log(`  ${m.from}: "${m.text}"\n`);
    }
    console.log(`  ${npcPersona.name}: "${npcThreadReply}"\n`);

    npc.close();
    visitor.close();
    process.exit(passed ? 0 : 1);
  } finally {
    relayProc.kill();
  }
}

main().catch((err) => {
  console.error("\n❌ Test crashed:", err);
  process.exit(1);
});
