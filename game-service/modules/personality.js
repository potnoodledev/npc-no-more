import { getDb } from "../db.js";
import { loadBranding } from "../branding.js";

const branding = loadBranding();
const pConfig = branding.personality || { axes: [], genres: [], zodiacMapping: {}, archetypes: [] };

export function initializePersonality(catId, zodiacSign) {
  const db = getDb();
  // Check if already initialized
  const existing = db.prepare("SELECT count(*) as n FROM personality_axes WHERE cat_id = ?").get(catId);
  if (existing.n > 0) return;

  const mapping = pConfig.zodiacMapping?.[zodiacSign] || {};
  const baseAxes = mapping.axes || {};
  const baseGenres = mapping.genres || [];

  // Insert axes (use mapping values or 0)
  const insertAxis = db.prepare("INSERT OR IGNORE INTO personality_axes (cat_id, axis_key, value) VALUES (?, ?, ?)");
  for (const axis of pConfig.axes) {
    const value = clamp(baseAxes[axis.key] || 0, -100, 100);
    insertAxis.run(catId, axis.key, value);
  }

  // Insert genre DNA — base genres from zodiac get 50-70, others get 5-15
  const insertGenre = db.prepare("INSERT OR IGNORE INTO genre_dna (cat_id, genre_key, affinity) VALUES (?, ?, ?)");
  for (const genre of pConfig.genres) {
    const isBase = baseGenres.includes(genre.key);
    const affinity = isBase ? 50 + Math.floor(Math.random() * 21) : 5 + Math.floor(Math.random() * 11);
    insertGenre.run(catId, genre.key, affinity);
  }

  // Pick 2 random archetypes
  const archetypes = pConfig.archetypes || [];
  const picked = shuffle([...archetypes]).slice(0, 2);
  const insertTag = db.prepare("INSERT OR IGNORE INTO archetype_tags (cat_id, tag, sort_order) VALUES (?, ?, ?)");
  picked.forEach((tag, i) => insertTag.run(catId, tag, i));

  // Log creation event
  addLifeEvent(catId, {
    event_type: "creation",
    title: `Born under ${zodiacSign || "unknown stars"}`,
    description: `Personality initialized with ${zodiacSign || "default"} traits.`,
    statChanges: null,
  });
}

export function getPersonality(catId) {
  const db = getDb();

  const axesRows = db.prepare("SELECT axis_key, value FROM personality_axes WHERE cat_id = ?").all(catId);
  const axes = pConfig.axes.map((def) => {
    const row = axesRows.find((r) => r.axis_key === def.key);
    return { ...def, value: row?.value ?? 0 };
  });

  const genreRows = db.prepare("SELECT genre_key, affinity FROM genre_dna WHERE cat_id = ?").all(catId);
  const genres = pConfig.genres.map((def) => {
    const row = genreRows.find((r) => r.genre_key === def.key);
    return { ...def, affinity: row?.affinity ?? 0 };
  });

  const archetypes = db.prepare("SELECT tag FROM archetype_tags WHERE cat_id = ? ORDER BY sort_order").all(catId).map((r) => r.tag);

  const lifeEvents = db.prepare("SELECT * FROM life_events WHERE cat_id = ? ORDER BY created_at DESC LIMIT 50").all(catId);

  return { axes, genres, archetypes, lifeEvents, zodiacSign: getCatZodiac(catId) };
}

export function shiftAxis(catId, axisKey, delta) {
  const db = getDb();
  const clamped = clamp(delta, -3, 3);
  db.prepare(`
    UPDATE personality_axes SET value = MAX(-100, MIN(100, value + ?))
    WHERE cat_id = ? AND axis_key = ?
  `).run(clamped, catId, axisKey);
  const row = db.prepare("SELECT value FROM personality_axes WHERE cat_id = ? AND axis_key = ?").get(catId, axisKey);
  return row?.value ?? 0;
}

export function shiftGenre(catId, genreKey, delta) {
  const db = getDb();
  const clamped = clamp(delta, -2, 2);
  db.prepare(`
    UPDATE genre_dna SET affinity = MAX(0, MIN(100, affinity + ?))
    WHERE cat_id = ? AND genre_key = ?
  `).run(clamped, catId, genreKey);
  const row = db.prepare("SELECT affinity FROM genre_dna WHERE cat_id = ? AND genre_key = ?").get(catId, genreKey);
  return row?.affinity ?? 0;
}

export function addLifeEvent(catId, { event_type, title, description, statChanges }) {
  const db = getDb();

  // Apply stat changes if provided
  if (statChanges && typeof statChanges === "object") {
    for (const [key, delta] of Object.entries(statChanges)) {
      shiftAxis(catId, key, delta);
    }
  }

  db.prepare(`
    INSERT INTO life_events (cat_id, event_type, title, description, stat_changes_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(catId, event_type, title, description || null, statChanges ? JSON.stringify(statChanges) : null);

  // Prune old events beyond 50
  db.prepare(`
    DELETE FROM life_events WHERE cat_id = ? AND id NOT IN (
      SELECT id FROM life_events WHERE cat_id = ? ORDER BY created_at DESC LIMIT 50
    )
  `).run(catId, catId);
}

export function getPersonalityForPrompt(catId) {
  const db = getDb();
  const axesRows = db.prepare("SELECT axis_key, value FROM personality_axes WHERE cat_id = ?").all(catId);
  if (axesRows.length === 0) return "";

  const genreRows = db.prepare("SELECT genre_key, affinity FROM genre_dna WHERE cat_id = ? ORDER BY affinity DESC LIMIT 3").all(catId);
  const archetypes = db.prepare("SELECT tag FROM archetype_tags WHERE cat_id = ? ORDER BY sort_order").all(catId).map((r) => r.tag);

  const axisDescriptions = axesRows.map((r) => {
    const def = pConfig.axes.find((a) => a.key === r.axis_key);
    if (!def) return `${r.axis_key}: ${r.value}`;
    const direction = r.value < -10 ? `leans ${def.negLabel.toLowerCase()}` : r.value > 10 ? `leans ${def.posLabel.toLowerCase()}` : "neutral";
    return `${def.label} ${r.value} (${direction})`;
  });

  const genreDesc = genreRows.map((r) => {
    const def = pConfig.genres.find((g) => g.key === r.genre_key);
    return `${def?.label || r.genre_key} ${r.affinity}`;
  });

  const parts = [`Personality: ${axisDescriptions.join(", ")}.`];
  if (genreDesc.length) parts.push(`Top genres: ${genreDesc.join(", ")}.`);
  if (archetypes.length) parts.push(`Archetypes: ${archetypes.join(", ")}.`);

  return parts.join(" ");
}

function getCatZodiac(catId) {
  const db = getDb();
  const row = db.prepare("SELECT zodiac_sign FROM cats WHERE id = ?").get(catId);
  return row?.zodiac_sign || null;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
