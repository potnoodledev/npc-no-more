/**
 * NIP-98 HTTP Auth verification with admin pubkey enforcement.
 *
 * If ADMIN_PUBKEY is set, only that pubkey is accepted.
 * If ADMIN_PUBKEY is empty, the first valid request's pubkey becomes admin (self-setup).
 */

import { verifyEvent } from "nostr-tools/pure";
import { writeFileSync, readFileSync, existsSync } from "fs";

const MAX_AGE_SECONDS = 120;

let adminPubkey = process.env.ADMIN_PUBKEY || "";
const ADMIN_FILE = process.env.ADMIN_FILE || "/tmp/admin-pubkey.txt";

// Load persisted admin pubkey
if (!adminPubkey && existsSync(ADMIN_FILE)) {
  try { adminPubkey = readFileSync(ADMIN_FILE, "utf-8").trim(); } catch {}
}

export function getAdminPubkey() {
  return adminPubkey;
}

/**
 * Verify a NIP-98 Nostr auth header.
 * Returns { pubkey, isAdmin } or null if invalid.
 */
export function verifyNostrAuth(authHeaderValue) {
  if (!authHeaderValue || !authHeaderValue.startsWith("Nostr ")) return null;

  try {
    const base64 = authHeaderValue.slice(6);
    const event = JSON.parse(atob(base64));

    if (event.kind !== 27235) return null;
    if (!verifyEvent(event)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > MAX_AGE_SECONDS) return null;

    // Admin check: if no admin set yet, first valid signer becomes admin
    if (!adminPubkey) {
      adminPubkey = event.pubkey;
      try { writeFileSync(ADMIN_FILE, adminPubkey); } catch {}
      console.log(`[auth] Admin pubkey set: ${adminPubkey.slice(0, 16)}...`);
    }

    if (event.pubkey !== adminPubkey) {
      return null; // Only admin pubkey is allowed
    }

    return { pubkey: event.pubkey, isAdmin: true };
  } catch {
    return null;
  }
}
