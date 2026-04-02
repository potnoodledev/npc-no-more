const { verifyEvent } = require("nostr-tools/pure");

const MAX_AGE_SECONDS = 120;

/**
 * Verify a NIP-98 auth event directly (no whitelist check).
 * Any valid Nostr signature is accepted.
 * Returns { pubkey } or null.
 */
function verifyNostrAuth(authEvent) {
  if (!authEvent || authEvent.kind !== 27235) return null;
  try {
    if (!verifyEvent(authEvent)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - authEvent.created_at) > MAX_AGE_SECONDS) return null;
    return { pubkey: authEvent.pubkey };
  } catch {
    return null;
  }
}

module.exports = { verifyNostrAuth };
