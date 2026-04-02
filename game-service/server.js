import express from "express";
import cors from "cors";
import { verifyEvent } from "nostr-tools/pure";
import { getDb } from "./db.js";
import { seedIfEmpty } from "./seed-data.js";
import { registerCat, getCatsByOwner, getCatById, getCatByCharacterPubkey, verifyCatOwner } from "./modules/cats.js";
import { getDailies, completeDaily } from "./modules/quests.js";
import { getTodos, createTodo, updateTodo, completeTodo, deleteTodo } from "./modules/todos.js";
import { recordCareActivity, addEnergy, spendEnergy } from "./modules/care.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3458;

// ── Initialize DB ──
getDb();
seedIfEmpty();

// ── Auth — verify NIP-98 signature directly ──
// The game service is open to any valid Nostr identity (no whitelist needed).

const MAX_AGE_SECONDS = 120;

function verifyNostrAuth(authHeaderValue) {
  if (!authHeaderValue || !authHeaderValue.startsWith("Nostr ")) return null;
  try {
    const base64 = authHeaderValue.slice(6);
    const event = JSON.parse(atob(base64));
    if (event.kind !== 27235) return null;
    if (!verifyEvent(event)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > MAX_AGE_SECONDS) return null;
    return { pubkey: event.pubkey };
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.path.startsWith("/internal/")) return next();

  const auth = verifyNostrAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.pubkey = auth.pubkey;
  next();
});

// ── Middleware: verify cat ownership ──

function requireCatOwner(req, res, next) {
  const catId = parseInt(req.params.catId);
  if (isNaN(catId)) return res.status(400).json({ error: "invalid cat id" });
  if (!verifyCatOwner(catId, req.pubkey)) {
    return res.status(403).json({ error: "not your cat" });
  }
  req.catId = catId;
  next();
}

// ── Health ──

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "game" });
});

// ── Cat Routes ──

app.get("/game/cats", (req, res) => {
  const cats = getCatsByOwner(req.pubkey);
  res.json(cats);
});

app.post("/game/cats", (req, res) => {
  const { character_pubkey, name } = req.body;
  if (!character_pubkey || !name) {
    return res.status(400).json({ error: "character_pubkey and name required" });
  }
  const result = registerCat(req.pubkey, character_pubkey, name);
  res.json(result);
});

app.get("/game/cats/:catId", requireCatOwner, (req, res) => {
  const cat = getCatById(req.catId);
  if (!cat) return res.status(404).json({ error: "cat not found" });
  res.json(cat);
});

// ── Daily Quest Routes ──

app.get("/game/cats/:catId/dailies", requireCatOwner, (req, res) => {
  const dailies = getDailies(req.catId);
  res.json(dailies);
});

app.post("/game/cats/:catId/dailies/:questId/complete", requireCatOwner, (req, res) => {
  const questId = parseInt(req.params.questId);
  if (isNaN(questId)) return res.status(400).json({ error: "invalid quest id" });
  const result = completeDaily(req.catId, questId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ── Todo Routes ──

app.get("/game/cats/:catId/todos", requireCatOwner, (req, res) => {
  const includeCompleted = req.query.completed === "true";
  const todos = getTodos(req.catId, includeCompleted);
  res.json(todos);
});

app.post("/game/cats/:catId/todos", requireCatOwner, (req, res) => {
  const { title, description, category, recurring } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  const todo = createTodo(req.catId, { title, description, category, recurring });
  res.json(todo);
});

app.put("/game/cats/:catId/todos/:todoId", requireCatOwner, (req, res) => {
  const todoId = parseInt(req.params.todoId);
  if (isNaN(todoId)) return res.status(400).json({ error: "invalid todo id" });
  const todo = updateTodo(req.catId, todoId, req.body);
  if (!todo) return res.status(404).json({ error: "todo not found" });
  res.json(todo);
});

app.post("/game/cats/:catId/todos/:todoId/complete", requireCatOwner, (req, res) => {
  const todoId = parseInt(req.params.todoId);
  if (isNaN(todoId)) return res.status(400).json({ error: "invalid todo id" });
  const result = completeTodo(req.catId, todoId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete("/game/cats/:catId/todos/:todoId", requireCatOwner, (req, res) => {
  const todoId = parseInt(req.params.todoId);
  if (isNaN(todoId)) return res.status(400).json({ error: "invalid todo id" });
  const ok = deleteTodo(req.catId, todoId);
  if (!ok) return res.status(404).json({ error: "todo not found" });
  res.json({ ok: true });
});

// ── Internal Routes (no auth, for room-server / pi-bridge) ──

app.get("/internal/cat-by-pubkey/:pubkey", (req, res) => {
  const cat = getCatByCharacterPubkey(req.params.pubkey);
  if (!cat) return res.status(404).json({ error: "cat not found" });
  res.json(cat);
});

app.post("/internal/verify-activity", (req, res) => {
  const { character_pubkey, activity_type } = req.body;
  if (!character_pubkey || !activity_type) {
    return res.status(400).json({ error: "character_pubkey and activity_type required" });
  }
  // TODO: auto-verify quests based on activity_type (room_visit, agent_chat, nostr_post)
  res.json({ ok: true, noted: true });
});

app.get("/internal/cat-appearance/:pubkey", (req, res) => {
  const db = getDb();
  const cat = getCatByCharacterPubkey(req.params.pubkey);
  if (!cat) return res.status(404).json({ error: "cat not found" });

  // Get equipped items with their prompt modifiers
  const equipped = db.prepare(`
    SELECT e.slot, i.item_def_id, d.name, d.avatar_prompt_modifier
    FROM equipment e
    JOIN inventory i ON e.inventory_id = i.id
    JOIN item_definitions d ON i.item_def_id = d.id
    WHERE e.cat_id = ?
  `).all(cat.id);

  // Get active traits with their prompt modifiers
  const traits = db.prepare(`
    SELECT t.name, t.avatar_prompt_modifier
    FROM cat_traits ct
    JOIN trait_definitions t ON ct.trait_id = t.id
    WHERE ct.cat_id = ? AND ct.equipped = 1
  `).all(cat.id);

  const promptModifiers = [
    ...equipped.filter((e) => e.avatar_prompt_modifier).map((e) => e.avatar_prompt_modifier),
    ...traits.filter((t) => t.avatar_prompt_modifier).map((t) => t.avatar_prompt_modifier),
  ];

  res.json({ cat_id: cat.id, equipped, traits, promptModifiers });
});

// ── Start ──

app.listen(PORT, () => {
  console.log(`[game-service] listening on :${PORT}`);
});
