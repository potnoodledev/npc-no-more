import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { nsecEncode, npubEncode, decode } from "nostr-tools/nip19";
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from "nostr-tools/nip04";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// Our own relay (injected at build time)
const OWN_RELAY = import.meta.env.VITE_RELAY_URL || "";

const PUBLIC_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

export const DEFAULT_RELAYS = [
  ...(OWN_RELAY ? [OWN_RELAY] : []),
  ...PUBLIC_RELAYS,
];

export const PERSISTENT_RELAYS = OWN_RELAY ? [OWN_RELAY] : PUBLIC_RELAYS;

// Relay HTTP base URL (for admin API)
export const RELAY_HTTP_URL = OWN_RELAY
  ? OWN_RELAY.replace("wss://", "https://").replace("ws://", "http://")
  : "";

let pool = null;
export function getPool() {
  if (!pool) pool = new SimplePool();
  return pool;
}

// ── Key Management ──

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

export function accountFromNsec(nsecOrHex) {
  let sk;
  if (nsecOrHex.startsWith("nsec1")) {
    const { type, data } = decode(nsecOrHex);
    if (type !== "nsec") throw new Error("Invalid nsec");
    sk = data;
  } else {
    sk = hexToBytes(nsecOrHex);
  }
  const pk = getPublicKey(sk);
  return {
    sk,
    skHex: bytesToHex(sk),
    nsec: nsecEncode(sk),
    pk,
    npub: npubEncode(pk),
  };
}

export async function loginWithExtension() {
  if (!window.nostr) {
    throw new Error("No Nostr extension found. Install nos2x, Alby, or another NIP-07 extension.");
  }
  const pk = await window.nostr.getPublicKey();
  return { sk: null, skHex: null, nsec: null, pk, npub: npubEncode(pk), isExtension: true };
}

// ── Publishing ──

export async function publishEvent(event, account, relays = DEFAULT_RELAYS) {
  let signed;
  if (account.isExtension) {
    signed = await window.nostr.signEvent(event);
  } else {
    signed = finalizeEvent(event, account.sk);
  }
  const p = getPool();
  await Promise.allSettled(p.publish(relays, signed));
  return signed;
}

export async function publishNote(content, account, relays = DEFAULT_RELAYS) {
  return publishEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  }, account, relays);
}

export async function publishProfile(metadata, account, relays = DEFAULT_RELAYS) {
  return publishEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(metadata),
  }, account, relays);
}

// ── DMs (NIP-04) ──

export async function sendDM(content, recipientPk, account, relays = DEFAULT_RELAYS) {
  let encrypted;
  if (account.isExtension) {
    encrypted = await window.nostr.nip04.encrypt(recipientPk, content);
  } else {
    encrypted = await nip04Encrypt(account.sk, recipientPk, content);
  }
  return publishEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPk]],
    content: encrypted,
  }, account, relays);
}

export async function decryptDM(event, account) {
  const otherPk = event.pubkey === account.pk
    ? event.tags.find((t) => t[0] === "p")?.[1] || ""
    : event.pubkey;
  try {
    let plaintext;
    if (account.isExtension) {
      plaintext = await window.nostr.nip04.decrypt(otherPk, event.content);
    } else {
      plaintext = await nip04Decrypt(account.sk, otherPk, event.content);
    }
    return { plaintext, otherPk };
  } catch {
    return { plaintext: "[failed to decrypt]", otherPk };
  }
}

// ── Subscriptions ──

export function subscribeFeed(relays, onEvent, onEose, limit = 50) {
  return getPool().subscribeMany(relays, { kinds: [1], limit }, { onevent: onEvent, oneose: onEose });
}

export function subscribeUserFeed(relays, pubkey, onEvent, onEose, limit = 50) {
  return getPool().subscribeMany(relays, { kinds: [1], authors: [pubkey], limit }, { onevent: onEvent, oneose: onEose });
}

export function subscribeDMs(relays, myPubkey, onEvent, onEose) {
  let eoseCount = 0;
  const checkEose = () => { eoseCount++; if (eoseCount >= 2 && onEose) onEose(); };
  const sub1 = getPool().subscribeMany(relays, { kinds: [4], authors: [myPubkey], limit: 200 }, { onevent: onEvent, oneose: checkEose });
  const sub2 = getPool().subscribeMany(relays, { kinds: [4], "#p": [myPubkey], limit: 200 }, { onevent: onEvent, oneose: checkEose });
  return { close() { sub1.close(); sub2.close(); } };
}

export async function fetchProfile(relays, pubkey) {
  const event = await getPool().get(relays, { kinds: [0], authors: [pubkey] });
  if (event) {
    try { return { ...JSON.parse(event.content), _event: event }; } catch { return null; }
  }
  return null;
}

export async function fetchProfiles(relays, pubkeys) {
  if (pubkeys.length === 0) return {};
  const events = await getPool().querySync(relays, { kinds: [0], authors: pubkeys });
  const profiles = {};
  for (const ev of events) {
    try {
      if (!profiles[ev.pubkey] || profiles[ev.pubkey]._event.created_at < ev.created_at) {
        profiles[ev.pubkey] = { ...JSON.parse(ev.content), _event: ev };
      }
    } catch {}
  }
  return profiles;
}

// ── Relay Admin API ──

export async function relayGetConfig(adminSecret) {
  const res = await fetch(`${RELAY_HTTP_URL}/admin/config`, {
    headers: { Authorization: `Bearer ${adminSecret}` },
  });
  if (!res.ok) throw new Error("Failed to fetch config");
  return res.json();
}

export async function relaySaveConfig(adminSecret, config) {
  const res = await fetch(`${RELAY_HTTP_URL}/admin/config`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error("Failed to save config");
  return res.json();
}

export async function relayAddPubkey(adminSecret, pubkey, label) {
  const res = await fetch(`${RELAY_HTTP_URL}/admin/pubkeys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pubkey, label }),
  });
  if (!res.ok) throw new Error("Failed to add pubkey");
  return res.json();
}

export async function relayGetSetupStatus() {
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/setup-status`);
    if (!res.ok) return { setup_complete: false };
    return res.json();
  } catch {
    return { setup_complete: false };
  }
}

// ── Helpers ──

export function shortPubkey(pk) {
  const npub = npubEncode(pk);
  return npub.slice(0, 12) + "…" + npub.slice(-6);
}

export function formatTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

// ── Persistence ──

export function saveLocal(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

export function loadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function clearLocal(key) {
  localStorage.removeItem(key);
}
