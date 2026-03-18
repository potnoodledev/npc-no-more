/**
 * NIP-98 HTTP Auth with admin + whitelist.
 *
 * First valid signer becomes admin. Admin can add more pubkeys to the whitelist.
 * All whitelisted pubkeys can make authenticated requests.
 */

import { verifyEvent } from "nostr-tools/pure";
import { writeFileSync, readFileSync, existsSync } from "fs";

const MAX_AGE_SECONDS = 120;
const AUTH_FILE = process.env.AUTH_FILE || "/tmp/auth.json";

// State: admin pubkey + whitelist + invite keys
let authState = { admin: "", whitelist: [], inviteKeys: [] };

// Load persisted state
if (existsSync(AUTH_FILE)) {
  try {
    const loaded = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    authState = { admin: "", whitelist: [], inviteKeys: [], ...loaded };
  } catch {}
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

// ── Invite Keys ──

export function createInviteKey(maxUses = 1) {
  const key = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const invite = { key, maxUses, uses: 0, createdAt: Math.floor(Date.now() / 1000) };
  authState.inviteKeys.push(invite);
  saveState();
  console.log(`[auth] Invite key created: ${key} (max ${maxUses} uses)`);
  return invite;
}

export function getInviteKeys() {
  return authState.inviteKeys || [];
}

export function deleteInviteKey(key) {
  authState.inviteKeys = (authState.inviteKeys || []).filter((k) => k.key !== key);
  saveState();
}

export function redeemInviteKey(key, pubkey) {
  const invite = (authState.inviteKeys || []).find((k) => k.key === key);
  if (!invite) return { ok: false, error: "invalid invite key" };
  if (invite.uses >= invite.maxUses) return { ok: false, error: "invite key has been used up" };
  // Don't double-count same pubkey
  if (!invite.redeemedBy) invite.redeemedBy = [];
  if (invite.redeemedBy.includes(pubkey)) return { ok: true, alreadyRedeemed: true };
  invite.uses++;
  invite.redeemedBy.push(pubkey);
  // Auto-whitelist the pubkey
  if (!authState.whitelist.includes(pubkey)) {
    authState.whitelist.push(pubkey);
  }
  saveState();
  console.log(`[auth] Invite key redeemed by ${pubkey.slice(0, 16)}... (${invite.uses}/${invite.maxUses})`);
  return { ok: true };
}

export function resetAuth() {
  authState = { admin: "", whitelist: [], inviteKeys: [] };
  saveState();
  console.log("[auth] Auth state reset");
}
