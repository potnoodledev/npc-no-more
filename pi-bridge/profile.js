/**
 * Fetch NIP-01 profiles from the Nostr relay.
 */

import WebSocket from "ws";
import { SimplePool } from "nostr-tools/pool";

// nostr-tools needs WebSocket in Node
global.WebSocket = WebSocket;

let pool = null;
function getPool() {
  if (!pool) pool = new SimplePool();
  return pool;
}

export function closePool() {
  if (pool) {
    pool = null;
  }
}

/**
 * Fetch a NIP-01 kind:0 profile from the relay.
 * @param {string} relayUrl - WebSocket URL of the relay
 * @param {string} pubkeyHex - Full hex pubkey
 * @param {number} timeoutMs - Timeout in ms (default 5000)
 * @returns {Promise<object|null>} Parsed profile metadata or null
 */
export async function fetchProfile(relayUrl, pubkeyHex, timeoutMs = 5000) {
  try {
    const p = getPool();
    const event = await Promise.race([
      p.get([relayUrl], { kinds: [0], authors: [pubkeyHex] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (event) {
      return JSON.parse(event.content);
    }
    return null;
  } catch (err) {
    console.error(`[profile] Failed to fetch profile for ${pubkeyHex.slice(0, 12)}...: ${err.message}`);
    return null;
  }
}
