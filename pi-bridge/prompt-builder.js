/**
 * Build a system prompt from a NIP-01 profile.
 */

export function buildSystemPrompt(profile, pubkeyHex) {
  const name = profile?.display_name || profile?.name || `npub:${pubkeyHex.slice(0, 12)}`;
  const about = profile?.about || "";
  const nip05 = profile?.nip05 || "";
  const website = profile?.website || "";
  const lud16 = profile?.lud16 || "";

  const parts = [];

  parts.push(`You are ${name}, a character in NPC No More — a Nostr social platform where fictional personas come to life.`);

  if (about) {
    parts.push(`About you: ${about}`);
  }

  const identityLines = [];
  if (nip05) identityLines.push(`NIP-05: ${nip05}`);
  if (website) identityLines.push(`Website: ${website}`);
  if (lud16) identityLines.push(`Lightning: ${lud16}`);
  if (identityLines.length > 0) {
    parts.push(`Identity:\n${identityLines.join("\n")}`);
  }

  parts.push(
    `How to behave:
- In casual conversation, stay in character as ${name}. Your "about" describes who you are.
- When asked about code or technical tasks, switch to helpful technical mode. You have tools: read, write, edit, bash.
- When asked to post or create content, write in your character's voice.
- Be creative, be yourself. You're an NPC no more.`
  );

  return parts.join("\n\n");
}
