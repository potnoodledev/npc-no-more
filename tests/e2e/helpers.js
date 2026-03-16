/**
 * Shared helpers for Playwright E2E tests.
 *
 * Starts a local relay and Vite dev server before tests,
 * and tears them down after.
 */

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { encrypt as nip04Encrypt } from "nostr-tools/nip04";
import { bytesToHex } from "@noble/hashes/utils.js";
import { WebSocket } from "ws";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const RELAY_PORT = 7799;
const VITE_PORT = 5173;

export { RELAY_PORT, VITE_PORT };

// ── Process management ──

const children = [];

export function cleanup() {
  for (const proc of children) {
    try { proc.kill(); } catch {}
  }
  children.length = 0;
}

export function startRelay() {
  return new Promise((resolve, reject) => {
    const dataDir = "/tmp/npc-e2e-relay-" + Date.now();
    mkdirSync(dataDir, { recursive: true });

    const proc = spawn("node", [PROJECT_ROOT + "/relay/server.js"], {
      env: {
        ...process.env,
        PORT: String(RELAY_PORT),
        DATA_DIR: dataDir,
        ADMIN_SECRET: "test-secret",
        ALLOWED_KINDS: "0,1,3,4,5,6,7",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);

    let started = false;
    proc.stdout.on("data", (d) => {
      if (!started && d.toString().includes("NPC No More Relay")) {
        started = true;
        resolve(proc);
      }
    });
    proc.on("exit", (code) => {
      if (!started) reject(new Error(`Relay exited ${code}`));
    });
    setTimeout(() => { if (!started) reject(new Error("Relay timeout")); }, 10000);
  });
}

export function startVite() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [PROJECT_ROOT + "/node_modules/.bin/vite", "--host", "--port", String(VITE_PORT)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, VITE_RELAY_URL: `ws://localhost:${RELAY_PORT}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(proc);

    let started = false;
    const checkStart = (data) => {
      if (!started && data.toString().includes("ready")) {
        started = true;
        resolve(proc);
      }
    };
    proc.stdout.on("data", checkStart);
    proc.stderr.on("data", checkStart);
    proc.on("exit", (code) => {
      if (!started) reject(new Error(`Vite exited ${code}`));
    });
    setTimeout(() => { if (!started) reject(new Error("Vite timeout")); }, 15000);
  });
}

// ── Nostr helpers ──

export function createAccount() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return {
    sk,
    skHex: bytesToHex(sk),
    nsec: nsecEncode(sk),
    pk,
    npub: npubEncode(pk),
  };
}

export async function whitelistPubkey(pubkey, label = "test") {
  const res = await fetch(`http://localhost:${RELAY_PORT}/admin/pubkeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
    body: JSON.stringify({ pubkey, label }),
  });
  if (!res.ok) throw new Error("Failed to whitelist pubkey");
}

export class NostrClient {
  constructor(account) {
    this.account = account;
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${RELAY_PORT}`);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  async publish(kind, content, tags = []) {
    const ev = finalizeEvent(
      { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
      this.account.sk,
    );
    this.ws.send(JSON.stringify(["EVENT", ev]));
    await new Promise((r) => setTimeout(r, 100));
    return ev;
  }

  async publishNote(content) {
    return this.publish(1, content);
  }

  async publishReply(content, rootEvent, parentEvent) {
    const tags = [
      ["e", rootEvent.id, `ws://localhost:${RELAY_PORT}`, "root"],
      ["p", rootEvent.pubkey],
    ];
    if (parentEvent && parentEvent.id !== rootEvent.id) {
      tags.push(["e", parentEvent.id, `ws://localhost:${RELAY_PORT}`, "reply"]);
      if (parentEvent.pubkey !== rootEvent.pubkey) tags.push(["p", parentEvent.pubkey]);
    }
    return this.publish(1, content, tags);
  }

  async publishProfile(meta) {
    return this.publish(0, JSON.stringify(meta));
  }

  async sendDM(recipientPk, text) {
    const enc = await nip04Encrypt(this.account.sk, recipientPk, text);
    return this.publish(4, enc, [["p", recipientPk]]);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}
