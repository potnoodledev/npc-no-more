import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { nsecEncode, npubEncode, decode } from "nostr-tools/nip19";
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from "nostr-tools/nip04";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// Our own relay (injected at build time, falls back to empty)
const OWN_RELAY = import.meta.env.VITE_RELAY_URL || "";

// Public relays for discovery + fallback
const PUBLIC_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
];

// Own relay first (persistent), then public relays
export const DEFAULT_RELAYS = [
  ...(OWN_RELAY ? [OWN_RELAY] : []),
  ...PUBLIC_RELAYS,
];

// Just our relay — for writes that must persist
export const PERSISTENT_RELAYS = OWN_RELAY ? [OWN_RELAY] : PUBLIC_RELAYS;

// Singleton pool
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

export function loginWithNsec(nsecOrHex) {
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

// ── NIP-07 (Browser Extension) ──

export async function loginWithExtension() {
  if (!window.nostr) {
    throw new Error(
      "No Nostr extension found. Install nos2x, Alby, or another NIP-07 extension."
    );
  }
  const pk = await window.nostr.getPublicKey();
  return {
    sk: null,
    skHex: null,
    nsec: null,
    pk,
    npub: npubEncode(pk),
    isExtension: true,
  };
}

// ── Publishing ──

export async function publishNote(content, account, relays = DEFAULT_RELAYS) {
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  };

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

export async function publishProfile(
  metadata,
  account,
  relays = DEFAULT_RELAYS
) {
  const event = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(metadata),
  };

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

// ── Subscriptions ──

export function subscribeFeed(relays, onEvent, onEose, limit = 50) {
  const p = getPool();
  const sub = p.subscribeMany(
    relays,
    { kinds: [1], limit },
    {
      onevent: onEvent,
      oneose: onEose,
    }
  );
  return sub;
}

export function subscribeUserFeed(relays, pubkey, onEvent, onEose, limit = 50) {
  const p = getPool();
  const sub = p.subscribeMany(
    relays,
    { kinds: [1], authors: [pubkey], limit },
    {
      onevent: onEvent,
      oneose: onEose,
    }
  );
  return sub;
}

export async function fetchProfile(relays, pubkey) {
  const p = getPool();
  const event = await p.get(relays, {
    kinds: [0],
    authors: [pubkey],
  });
  if (event) {
    try {
      return { ...JSON.parse(event.content), _event: event };
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchProfiles(relays, pubkeys) {
  if (pubkeys.length === 0) return {};
  const p = getPool();
  const events = await p.querySync(relays, {
    kinds: [0],
    authors: pubkeys,
  });
  const profiles = {};
  for (const ev of events) {
    try {
      if (
        !profiles[ev.pubkey] ||
        profiles[ev.pubkey]._event.created_at < ev.created_at
      ) {
        profiles[ev.pubkey] = { ...JSON.parse(ev.content), _event: ev };
      }
    } catch {}
  }
  return profiles;
}

// ── Direct Messages (NIP-04) ──

export async function sendDM(content, recipientPk, account, relays = DEFAULT_RELAYS) {
  let encrypted;
  if (account.isExtension) {
    encrypted = await window.nostr.nip04.encrypt(recipientPk, content);
  } else {
    encrypted = await nip04Encrypt(account.sk, recipientPk, content);
  }

  const event = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPk]],
    content: encrypted,
  };

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

export async function decryptDM(event, account) {
  // Figure out who the other party is
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

export function subscribeDMs(relays, myPubkey, onEvent, onEose) {
  const p = getPool();
  // We need two filters: messages I sent + messages to me
  // subscribeMany with a single filter can't do OR on different fields,
  // so we make two subscriptions
  let eoseCount = 0;
  const checkEose = () => {
    eoseCount++;
    if (eoseCount >= 2 && onEose) onEose();
  };

  const sub1 = p.subscribeMany(
    relays,
    { kinds: [4], authors: [myPubkey], limit: 200 },
    { onevent: onEvent, oneose: checkEose }
  );

  const sub2 = p.subscribeMany(
    relays,
    { kinds: [4], "#p": [myPubkey], limit: 200 },
    { onevent: onEvent, oneose: checkEose }
  );

  // Return a combined closer
  return {
    close() {
      sub1.close();
      sub2.close();
    },
  };
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

export function saveAccount(account) {
  const serializable = {
    skHex: account.skHex,
    nsec: account.nsec,
    pk: account.pk,
    npub: account.npub,
    isExtension: account.isExtension || false,
  };
  localStorage.setItem("nostr_account", JSON.stringify(serializable));
}

export function loadAccount() {
  const raw = localStorage.getItem("nostr_account");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data.isExtension) {
      return { ...data, sk: null };
    }
    if (data.skHex) {
      const sk = hexToBytes(data.skHex);
      return { ...data, sk };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAccount() {
  localStorage.removeItem("nostr_account");
}
