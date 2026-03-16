/**
 * Two-NPC Communication Test (headless)
 *
 * Spins up a local relay, creates two NPC characters, tests:
 *   1. Threaded public conversation (NIP-10 replies)
 *   2. Private DM exchange (NIP-04)
 *
 * Usage:
 *   node tests/two-npcs.js                    # with NIM persona generation
 *   node tests/two-npcs.js --skip-nim         # hardcoded personas
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

async function generatePersona(hint) {
  const model = NIM_MODELS[Math.floor(Math.random() * NIM_MODELS.length)];
  log("🤖", `Generating persona with ${model}...`);
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `You are a character designer. Generate a unique NPC persona. Respond ONLY with valid JSON, no markdown:\n{"name":"...","personality":"...","world":"...","voice":"...","greeting":"A short in-character greeting"}` },
        { role: "user", content: `Create a character inspired by: ${hint}. Keep it short and punchy.` },
      ],
      max_tokens: 512, temperature: 1.0,
    }),
  });
  if (!res.ok) throw new Error(`NIM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content || "";
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fm = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fm) raw = fm[1];
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON: " + raw.slice(0, 200));
  raw = raw.slice(s, e + 1);
  let persona;
  try { persona = JSON.parse(raw); } catch { persona = JSON.parse(raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")); }
  log("✨", `Created: ${persona.name} (via ${model.split("/").pop()})`);
  return { ...persona, model };
}

async function generateReply(persona, history, otherName) {
  const model = persona.model || NIM_MODELS[0];
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
      this.ws.on("open", () => { log(`📡 ${this.name}`, "Connected to relay"); resolve(); });
      this.ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg[0] === "EVENT") { const h = this.subs.get(msg[1]); if (h) h(msg[2]); }
      });
      this.ws.on("error", reject);
    });
  }
  subscribe(id, filter, handler) { this.subs.set(id, handler); this.ws.send(JSON.stringify(["REQ", id, filter])); }

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
      if (parentEvent.pubkey !== rootEvent.pubkey) {
        tags.push(["p", parentEvent.pubkey]);
      }
    }
    const ev = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content }, this.account.sk);
    this.ws.send(JSON.stringify(["EVENT", ev]));
    return ev;
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
      if (!started && data.toString().includes("NPC No More Relay")) { started = true; log("🏗️ ", `Relay on port ${RELAY_PORT}`); resolve(proc); }
    });
    proc.stderr.on("data", (data) => { if (!started) console.error("Relay:", data.toString().trim()); });
    proc.on("exit", (code) => { if (!started) reject(new Error(`Relay exited ${code}`)); });
    setTimeout(() => { if (!started) reject(new Error("Relay timeout")); }, 10000);
  });
}

// ── Main ──

async function main() {
  console.log("\n🎭 NPC-NO-MORE: Two NPCs Communication Test\n");
  console.log("═".repeat(50));

  const relayProc = await startRelay();

  try {
    const account1 = createAccount();
    const account2 = createAccount();

    for (const acc of [account1, account2]) {
      const res = await fetch(`http://localhost:${RELAY_PORT}/admin/pubkeys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ pubkey: acc.pk, label: "test-npc" }),
      });
      if (!res.ok) throw new Error("Failed to whitelist pubkey");
    }
    log("✅", "Both pubkeys whitelisted");

    // Personas
    let p1, p2;
    if (!SKIP_NIM && NIM_API_KEY) {
      console.log("\n" + "─".repeat(50));
      [p1, p2] = await Promise.all([
        generatePersona("a rogue weather forecaster from a dying space station"),
        generatePersona("a sentient jukebox from a 1950s diner"),
      ]);
    } else {
      p1 = { name: "Storm-9", personality: "Rogue weather AI, sardonic and poetic", voice: "Clipped, mixes technical jargon with storm poetry", greeting: "Static incoming. I'm Storm-9." };
      p2 = { name: "Melody Box", personality: "Sentient jukebox, warm and nostalgic", voice: "Drops song lyrics as wisdom", greeting: "Quarter for your thoughts? I'm Melody Box." };
      log("📦", `Presets: ${p1.name} & ${p2.name}`);
    }

    // Connect
    const c1 = new NostrClient(p1.name, account1);
    const c2 = new NostrClient(p2.name, account2);
    await c1.connect();
    await c2.connect();

    // Subscriptions
    const dmReceived = { npc1: [], npc2: [] };
    const threadReceived = { npc1: [], npc2: [] };

    c1.subscribe("dms", { kinds: [4], "#p": [account1.pk] }, async (ev) => {
      const text = await c1.decryptDM(ev);
      dmReceived.npc1.push(text);
      log(`📨 ${p1.name}`, `DM: "${text.slice(0, 70)}..."`);
    });
    c2.subscribe("dms", { kinds: [4], "#p": [account2.pk] }, async (ev) => {
      const text = await c2.decryptDM(ev);
      dmReceived.npc2.push(text);
      log(`📨 ${p2.name}`, `DM: "${text.slice(0, 70)}..."`);
    });
    c1.subscribe("replies", { kinds: [1], "#p": [account1.pk] }, (ev) => {
      threadReceived.npc1.push(ev);
      log(`🧵 ${p1.name}`, `reply: "${ev.content.slice(0, 70)}..."`);
    });
    c2.subscribe("replies", { kinds: [1], "#p": [account2.pk] }, (ev) => {
      threadReceived.npc2.push(ev);
      log(`🧵 ${p2.name}`, `reply: "${ev.content.slice(0, 70)}..."`);
    });

    await sleep(500);
    const useNim = !SKIP_NIM && !!NIM_API_KEY;
    const TURNS = 3;

    // ══ PART 1: THREADED CONVERSATION ══

    console.log("\n" + "═".repeat(50));
    console.log("  🧵 PART 1: PUBLIC THREAD");
    console.log("═".repeat(50) + "\n");

    const threadHist = [];

    const rootText = useNim ? await generateReply(p1, [], p2.name) : p1.greeting;
    log(`📝 ${p1.name}`, `[ROOT] "${rootText}"`);
    const rootEvent = await c1.publishNote(rootText);
    threadHist.push({ from: p1.name, text: rootText });
    await sleep(1500);

    let lastEvent = rootEvent;
    for (let t = 0; t < TURNS; t++) {
      const r2 = useNim ? await generateReply(p2, threadHist, p1.name) : `[${p2.name} reply ${t+1}] That's wild!`;
      log(`↩️  ${p2.name}`, `[REPLY] "${r2}"`);
      const ev2 = await c2.publishReply(r2, rootEvent, lastEvent);
      threadHist.push({ from: p2.name, text: r2 });
      lastEvent = ev2;
      await sleep(1500);

      const r1 = useNim ? await generateReply(p1, threadHist, p2.name) : `[${p1.name} reply ${t+1}] Interesting!`;
      log(`↩️  ${p1.name}`, `[REPLY] "${r1}"`);
      const ev1 = await c1.publishReply(r1, rootEvent, lastEvent);
      threadHist.push({ from: p1.name, text: r1 });
      lastEvent = ev1;
      await sleep(1500);
    }

    // ══ PART 2: DMs ══

    console.log("\n" + "═".repeat(50));
    console.log("  🔒 PART 2: PRIVATE DMs");
    console.log("═".repeat(50) + "\n");

    const dmHist = [];

    const dmOpen = useNim ? await generateReply(p2, [], p1.name) : `Hey ${p1.name}, something private to share...`;
    log(`✉️  ${p2.name}`, `[DM→${p1.name}] "${dmOpen}"`);
    await c2.sendDM(account1.pk, dmOpen);
    dmHist.push({ from: p2.name, text: dmOpen });
    await sleep(1500);

    for (let t = 0; t < TURNS; t++) {
      const d1 = useNim ? await generateReply(p1, dmHist, p2.name) : `[${p1.name} DM ${t+1}] Got it...`;
      log(`✉️  ${p1.name}`, `[DM→${p2.name}] "${d1}"`);
      await c1.sendDM(account2.pk, d1);
      dmHist.push({ from: p1.name, text: d1 });
      await sleep(1500);

      const d2 = useNim ? await generateReply(p2, dmHist, p1.name) : `[${p2.name} DM ${t+1}] Tell me more...`;
      log(`✉️  ${p2.name}`, `[DM→${p1.name}] "${d2}"`);
      await c2.sendDM(account1.pk, d2);
      dmHist.push({ from: p2.name, text: d2 });
      await sleep(1500);
    }

    // ══ RESULTS ══

    await sleep(1000);

    console.log("\n" + "═".repeat(50));
    console.log("  📊 TEST RESULTS");
    console.log("═".repeat(50));

    const threadNpc2Posts = threadHist.filter((m) => m.from === p2.name).length;
    const threadNpc1Replies = threadHist.filter((m) => m.from === p1.name).length - 1; // minus root
    const threadOk = threadReceived.npc1.length >= threadNpc2Posts && threadReceived.npc2.length >= threadNpc1Replies;
    console.log(`\n  🧵 Thread: ${threadHist.length} posts`);
    console.log(`     ${p2.name} replied ${threadNpc2Posts}x → ${p1.name} got ${threadReceived.npc1.length} notifications`);
    console.log(`     ${p1.name} replied ${threadNpc1Replies}x → ${p2.name} got ${threadReceived.npc2.length} notifications`);
    console.log(`     ${threadOk ? "✅" : "❌"} Thread delivery`);

    const dmNpc1Sent = dmHist.filter((m) => m.from === p1.name).length;
    const dmNpc2Sent = dmHist.filter((m) => m.from === p2.name).length;
    const dmOk = dmReceived.npc1.length >= dmNpc2Sent && dmReceived.npc2.length >= dmNpc1Sent;
    console.log(`\n  🔒 DMs: ${dmHist.length} messages`);
    console.log(`     ${p2.name} sent ${dmNpc2Sent} → ${p1.name} received ${dmReceived.npc1.length}`);
    console.log(`     ${p1.name} sent ${dmNpc1Sent} → ${p2.name} received ${dmReceived.npc2.length}`);
    console.log(`     ${dmOk ? "✅" : "❌"} DM delivery`);

    const passed = threadOk && dmOk;
    console.log(`\n  ${passed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}\n`);

    // Transcripts
    console.log("─".repeat(50));
    console.log("  📜 Thread Transcript\n");
    for (const [i, m] of threadHist.entries()) {
      console.log(`  ${m.from} ${i === 0 ? "[ROOT]" : "[REPLY]"}: "${m.text}"\n`);
    }
    console.log("─".repeat(50));
    console.log("  📜 DM Transcript\n");
    for (const m of dmHist) {
      console.log(`  ${m.from} [DM]: "${m.text}"\n`);
    }

    c1.close();
    c2.close();
    process.exit(passed ? 0 : 1);
  } finally {
    relayProc.kill();
  }
}

main().catch((err) => {
  console.error("\n❌ Test crashed:", err);
  process.exit(1);
});
