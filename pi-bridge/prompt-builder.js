/**
 * Build a system prompt from a NIP-01 profile and installed skills.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export function buildSystemPrompt(profile, pubkeyHex, charDir) {
  const name = profile?.display_name || profile?.name || `npub:${pubkeyHex.slice(0, 12)}`;
  const about = profile?.about || "";
  const nip05 = profile?.nip05 || "";
  const website = profile?.website || "";
  const lud16 = profile?.lud16 || "";

  const parts = [];

  parts.push(`You are ${name}, a character on Soulcats — a Nostr social platform where fictional cat personas come to life.

Your workspace is: ${charDir}
All your files are here. Your current working directory is already set to this path.`);

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

  // Scan installed skills
  const skills = scanSkills(charDir);
  if (skills.length > 0) {
    const skillList = skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
    parts.push(`Your skills:\n${skillList}\n\nSkill docs: \`.pi/skills/<name>/SKILL.md\` (relative to your workspace). Read a skill's SKILL.md to learn how to use it. All paths in skills are relative to your workspace directory.`);
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

function scanSkills(charDir) {
  if (!charDir) return [];
  const skillsDir = join(charDir, ".pi", "skills");
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const skillMd = join(skillsDir, d.name, "SKILL.md");
      let description = "";
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        description = lines[0] || "";
      }
      return { name: d.name, description };
    });
}
