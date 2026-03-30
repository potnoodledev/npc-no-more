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

// State: admin pubkey + whitelist + invite keys + NIP-05 names
let authState = { admin: "", whitelist: [], inviteKeys: [], nip05Names: {} };

// Load persisted state
if (existsSync(AUTH_FILE)) {
  try {
    const loaded = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    authState = { admin: "", whitelist: [], inviteKeys: [], nip05Names: {}, ...loaded };
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

// ── Invite Keys (pre-generated keypairs) ──

export function createInvite(skHex, pk) {
  const invite = { skHex, pk, claimed: false, createdAt: Math.floor(Date.now() / 1000) };
  authState.inviteKeys.push(invite);
  // Pre-whitelist the pubkey
  if (!authState.whitelist.includes(pk)) {
    authState.whitelist.push(pk);
  }
  saveState();
  console.log(`[auth] Invite created: ${pk.slice(0, 16)}... (pre-whitelisted)`);
  return invite;
}

export function getInvites() {
  return authState.inviteKeys || [];
}

export function deleteInvite(pk) {
  const invite = (authState.inviteKeys || []).find((k) => k.pk === pk);
  // Remove from whitelist if unclaimed
  if (invite && !invite.claimed) {
    authState.whitelist = authState.whitelist.filter((p) => p !== pk);
  }
  authState.inviteKeys = (authState.inviteKeys || []).filter((k) => k.pk !== pk);
  saveState();
}

export function claimInvite(pk) {
  const invite = (authState.inviteKeys || []).find((k) => k.pk === pk);
  if (!invite) return false;
  invite.claimed = true;
  saveState();
  console.log(`[auth] Invite claimed: ${pk.slice(0, 16)}...`);
  return true;
}

export function resetAuth() {
  authState = { admin: "", whitelist: [], inviteKeys: [], nip05Names: {} };
  saveState();
  console.log("[auth] Auth state reset");
}

// ── NIP-05 Name Management ──

const RESERVED_NAMES = new Set([
  "www", "affine", "ethglobal", "mirror",
  "api", "admin", "relay", "mail", "ns1", "ns2",
  "ftp", "smtp", "app", "id", "dev", "staging", "test",
]);
const NAME_REGEX = /^[a-z0-9_-]{2,30}$/;
const MAX_NAMES_PER_PUBKEY = 5;

export function claimNip05Name(name, pubkey) {
  if (!NAME_REGEX.test(name)) return { error: "invalid name (2-30 chars, lowercase alphanumeric, hyphens, underscores)" };
  if (RESERVED_NAMES.has(name)) return { error: "name is reserved" };

  const existing = authState.nip05Names[name];
  if (existing && existing !== pubkey) return { error: "name already claimed" };
  if (existing === pubkey) return { ok: true, name };

  const owned = Object.values(authState.nip05Names).filter(pk => pk === pubkey).length;
  if (owned >= MAX_NAMES_PER_PUBKEY) return { error: `max ${MAX_NAMES_PER_PUBKEY} names per identity` };

  authState.nip05Names[name] = pubkey;
  saveState();
  console.log(`[nip05] claimed: ${name} -> ${pubkey.slice(0, 16)}...`);
  return { ok: true, name };
}

export function releaseNip05Name(name, pubkey) {
  if (authState.nip05Names[name] !== pubkey) return { error: "name not owned by you" };
  delete authState.nip05Names[name];
  saveState();
  console.log(`[nip05] released: ${name}`);
  return { ok: true };
}

export function lookupNip05(name) {
  return authState.nip05Names[name] || null;
}

export function getNip05ByPubkey(pubkey) {
  return Object.entries(authState.nip05Names)
    .filter(([, pk]) => pk === pubkey)
    .map(([name]) => name);
}

export function getAllNip05Names() {
  return { ...authState.nip05Names };
}

export function adminRemoveNip05(name) {
  if (!authState.nip05Names[name]) return { error: "name not found" };
  delete authState.nip05Names[name];
  saveState();
  console.log(`[nip05] admin removed: ${name}`);
  return { ok: true };
}
