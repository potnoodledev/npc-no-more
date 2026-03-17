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
export const OWN_RELAY = import.meta.env.VITE_RELAY_URL || "";

export const PUBLIC_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

// If we have our own relay, use it exclusively for the feed.
// Public relays are fallback only when no private relay is configured.
export const DEFAULT_RELAYS = OWN_RELAY ? [OWN_RELAY] : PUBLIC_RELAYS;

// All relays combined (for profile lookups that should search everywhere)
export const ALL_RELAYS = [...new Set([...DEFAULT_RELAYS, ...PUBLIC_RELAYS])];

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

export function accountFromSkHex(skHex) {
  const sk = hexToBytes(skHex);
  const pk = getPublicKey(sk);
  return { sk, skHex, nsec: nsecEncode(sk), pk, npub: npubEncode(pk) };
}

// ── Client tag ──

export const CLIENT_TAG = ["client", "npc-no-more"];
// Single-letter tag for relay-compatible filtering (relays only support #<single-char> filters)
export const CLIENT_FILTER_TAG = ["l", "npc-no-more"];

// ── NIP-98 HTTP Auth ──

export async function createAuthEvent(url, method, account) {
  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
    ],
    content: "",
  };
  if (account.isExtension) {
    return await window.nostr.signEvent(event);
  }
  return finalizeEvent(event, account.sk);
}

export function authHeader(signedEvent) {
  return "Nostr " + btoa(JSON.stringify(signedEvent));
}

export async function getAuthHeaders(url, method, account) {
  const event = await createAuthEvent(url, method, account);
  return {
    "Content-Type": "application/json",
    "Authorization": authHeader(event),
  };
}

// ── Publishing ──

export async function publishEvent(event, account, relays = DEFAULT_RELAYS) {
  const tagged = {
    ...event,
    tags: [...(event.tags || []), CLIENT_TAG, CLIENT_FILTER_TAG],
  };
  let signed;
  if (account.isExtension) {
    signed = await window.nostr.signEvent(tagged);
  } else {
    signed = finalizeEvent(tagged, account.sk);
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

// ── Follows (kind:3 contact list) ──

export async function fetchFollows(relays, pubkey) {
  const event = await getPool().get(relays, { kinds: [3], authors: [pubkey] });
  if (!event) return [];
  return event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
}

export async function publishFollows(followPubkeys, account, relays = DEFAULT_RELAYS) {
  const tags = followPubkeys.map((pk) => ["p", pk]);
  return publishEvent({
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  }, account, relays);
}

// ── Subscriptions ──

export function subscribeFeed(relays, onEvent, onEose, limit = 50) {
  return getPool().subscribeMany(relays, { kinds: [1], "#l": ["npc-no-more"], limit }, { onevent: onEvent, oneose: onEose });
}

export function subscribeGlobalFeed(relays, onEvent, onEose, limit = 50) {
  return getPool().subscribeMany(relays, { kinds: [1], limit }, { onevent: onEvent, oneose: onEose });
}

export function subscribeUserFeed(relays, pubkey, onEvent, onEose, limit = 50) {
  let eoseCount = 0;
  const checkEose = () => { eoseCount++; if (eoseCount >= 2 && onEose) onEose(); };
  const sub1 = getPool().subscribeMany(relays, { kinds: [1], authors: [pubkey], "#l": ["npc-no-more"], limit }, { onevent: onEvent, oneose: checkEose });
  const sub2 = getPool().subscribeMany(relays, { kinds: [1], "#p": [pubkey], "#l": ["npc-no-more"], limit }, { onevent: onEvent, oneose: checkEose });
  return { close() { sub1.close(); sub2.close(); } };
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

// ── Admin Account ──

export function loadAdminAccount() {
  const data = loadLocal("npc_admin_account");
  if (data?.skHex) {
    const acc = accountFromSkHex(data.skHex);
    acc.profile_name = data.profile_name || "";
    acc.profile_about = data.profile_about || "";
    acc.profile_image = data.profile_image || "";
    return acc;
  }
  return null;
}

export function saveAdminAccount(account) {
  saveLocal("npc_admin_account", {
    skHex: account.skHex, pk: account.pk, npub: account.npub,
    profile_name: account.profile_name || "",
    profile_about: account.profile_about || "",
    profile_image: account.profile_image || "",
  });
}

export function createAdminAccount() {
  const acc = createAccount();
  saveAdminAccount(acc);
  return acc;
}

// ── Characters Persistence ──

export function loadCharacters() {
  return loadLocal("npc_characters") || [];
}

export function saveCharacters(chars) {
  saveLocal("npc_characters", chars);
}

export function loadActiveCharId() {
  return loadLocal("npc_active_character_id");
}

export function saveActiveCharId(id) {
  saveLocal("npc_active_character_id", id);
}

// Migrate old single-character data to new multi-character format
export function migrateOldData() {
  const oldConfig = loadLocal("npc_config");
  const oldCharAccount = loadLocal("npc_character_account");
  if (!oldConfig || !oldCharAccount) return null;

  const char = oldConfig.character || {};
  const migrated = {
    id: crypto.randomUUID(),
    name: char.name || "Unnamed",
    personality: char.personality || "",
    world: char.world || "",
    voice: char.voice || "",
    profile_image: char.profile_image || "",
    banner_image: char.banner_image || "",
    origin_story: char.origin_story || [],
    skHex: oldCharAccount.skHex,
    nsec: oldCharAccount.nsec,
    pk: oldCharAccount.pk,
    npub: oldCharAccount.npub,
    createdAt: Math.floor(Date.now() / 1000),
  };

  saveCharacters([migrated]);
  saveActiveCharId(migrated.id);

  // Clean up old keys
  clearLocal("npc_config");
  clearLocal("npc_character_account");
  clearLocal("npc_admin_account");
  clearLocal("npc_admin_secret");
  clearLocal("npc_visitor_account");

  return migrated;
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
