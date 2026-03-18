/**
 * NIP-98 HTTP Auth with admin + whitelist.
 *
 * First valid signer becomes admin. Admin can add more pubkeys to the whitelist.
 * All whitelisted pubkeys can make authenticated requests.
 */

import { verifyEvent } from "nostr-tools/pure";
import { writeFileSync, readFileSync, existsSync } from "fs";

const MAX_AGE_SECONDS = 120;
const AUTH_FILE = process.env.AUTH_FILE || "/data/images/auth.json";

// State: admin pubkey + whitelist
let authState = { admin: "", whitelist: [] };

// Load persisted state
if (existsSync(AUTH_FILE)) {
  try { authState = JSON.parse(readFileSync(AUTH_FILE, "utf-8")); } catch {}
}
if (process.env.ADMIN_PUBKEY && !authState.admin) {
  authState.admin = process.env.ADMIN_PUBKEY;
}

function saveState() {
  try { writeFileSync(AUTH_FILE, JSON.stringify(authState, null, 2)); } catch {}
}

export function getAuthState() {
  return { admin: authState.admin, whitelist: authState.whitelist };
}

export function isAllowedPubkey(pubkey) {
  if (!authState.admin) return true; // No admin yet = open
  return pubkey === authState.admin || authState.whitelist.includes(pubkey);
}

export function addToWhitelist(pubkey) {
  if (!authState.whitelist.includes(pubkey)) {
    authState.whitelist.push(pubkey);
    saveState();
  }
}

export function removeFromWhitelist(pubkey) {
  authState.whitelist = authState.whitelist.filter((p) => p !== pubkey);
  saveState();
}

/**
 * Verify a NIP-98 Nostr auth header.
 * Returns { pubkey, isAdmin } or null if invalid/unauthorized.
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

    // Must be admin or whitelisted
    if (!isAllowedPubkey(event.pubkey)) return null;

    return { pubkey: event.pubkey, isAdmin: event.pubkey === authState.admin };
  } catch {
    return null;
  }
}

/**
 * Claim admin — only works when no admin is set yet.
 * Returns true if claimed, false if admin already exists.
 */
export function claimAdmin(pubkey) {
  if (authState.admin) return false;
  authState.admin = pubkey;
  saveState();
  console.log(`[auth] Admin pubkey set: ${authState.admin.slice(0, 16)}...`);
  return true;
}

export function resetAuth() {
  authState = { admin: "", whitelist: [] };
  saveState();
  console.log("[auth] Auth state reset");
}
