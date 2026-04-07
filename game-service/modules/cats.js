import { getDb } from "../db.js";
import { loadBranding } from "../branding.js";
import crypto from "crypto";

const branding = loadBranding();
const CURRENCY = branding.currency || "shinies";

export function registerCat(ownerPubkey, characterPubkey, name) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM cats WHERE character_pubkey = ?").get(characterPubkey);
  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO cats (pubkey, character_pubkey, name) VALUES (?, ?, ?)
  `).run(ownerPubkey, characterPubkey, name);

  // Initialize currency
  db.prepare("INSERT INTO currencies (cat_id, currency, balance) VALUES (?, ?, 0)").run(result.lastInsertRowid, CURRENCY);

  return { id: result.lastInsertRowid };
}

export function getCatsByOwner(ownerPubkey) {
  const db = getDb();
  return db.prepare("SELECT * FROM cats WHERE pubkey = ?").all(ownerPubkey);
}

export function getCatById(catId) {
  const db = getDb();
  const cat = db.prepare("SELECT * FROM cats WHERE id = ?").get(catId);
  if (!cat) return null;
  const currencies = db.prepare("SELECT currency, balance FROM currencies WHERE cat_id = ?").all(catId);
  return { ...cat, currencies };
}

export function getCatByCharacterPubkey(characterPubkey) {
  const db = getDb();
  const cat = db.prepare("SELECT * FROM cats WHERE character_pubkey = ?").get(characterPubkey);
  if (!cat) return null;
  const currencies = db.prepare("SELECT currency, balance FROM currencies WHERE cat_id = ?").all(cat.id);
  return { ...cat, currencies };
}

// Verify caller owns this cat
export function verifyCatOwner(catId, ownerPubkey) {
  const db = getDb();
  const cat = db.prepare("SELECT id FROM cats WHERE id = ? AND pubkey = ?").get(catId, ownerPubkey);
  return !!cat;
}

export function addXp(catId, amount) {
  const db = getDb();
  const cat = db.prepare("SELECT * FROM cats WHERE id = ?").get(catId);
  if (!cat) return null;

  let newXp = cat.xp + amount;
  let level = cat.level;
  let maxHp = cat.max_hp;
  let maxEnergy = cat.max_energy;
  let courage = cat.courage;
  let resilience = cat.resilience;
  let agility = cat.agility;
  let charm = cat.charm;
  let leveledUp = false;

  // Check for level-ups (possibly multiple)
  while (newXp >= level * 100) {
    newXp -= level * 100;
    level++;
    maxHp += 5;
    leveledUp = true;

    // +1 max_energy every 3 levels
    if (level % 3 === 0) maxEnergy++;

    // +1 to two deterministic stats
    const seed = crypto.createHash("sha256").update(`${catId}:level:${level}`).digest("hex");
    const stats = ["courage", "resilience", "agility", "charm"];
    const i1 = parseInt(seed.slice(0, 8), 16) % 4;
    const i2 = (i1 + 1 + (parseInt(seed.slice(8, 16), 16) % 3)) % 4;
    const bumps = { courage: 0, resilience: 0, agility: 0, charm: 0 };
    bumps[stats[i1]]++;
    bumps[stats[i2]]++;
    courage += bumps.courage;
    resilience += bumps.resilience;
    agility += bumps.agility;
    charm += bumps.charm;
  }

  db.prepare(`
    UPDATE cats SET xp = ?, level = ?, max_hp = ?, hp = MIN(hp + ?, max_hp),
      max_energy = ?, courage = ?, resilience = ?, agility = ?, charm = ?
    WHERE id = ?
  `).run(newXp, level, maxHp, leveledUp ? 5 : 0, maxEnergy, courage, resilience, agility, charm, catId);

  return { level, xp: newXp, leveledUp, maxHp, maxEnergy };
}

export function addCurrency(catId, currency, amount) {
  const db = getDb();
  db.prepare(`
    INSERT INTO currencies (cat_id, currency, balance) VALUES (?, ?, ?)
    ON CONFLICT(cat_id, currency) DO UPDATE SET balance = balance + ?
  `).run(catId, currency, amount, amount);
}
