import { getDb } from "../db.js";
import { addXp, addCurrency } from "./cats.js";
import { recordCareActivity } from "./care.js";
import { loadBranding } from "../branding.js";

const CURRENCY = loadBranding().currency || "shinies";

export function getTodos(catId, includeCompleted = false) {
  const db = getDb();
  if (includeCompleted) {
    return db.prepare("SELECT * FROM todo_items WHERE cat_id = ? ORDER BY created_at DESC").all(catId);
  }
  return db.prepare("SELECT * FROM todo_items WHERE cat_id = ? AND status = 'active' ORDER BY created_at DESC").all(catId);
}

export function createTodo(catId, { title, description, category, recurring }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO todo_items (cat_id, title, description, category, recurring)
    VALUES (?, ?, ?, ?, ?)
  `).run(catId, title, description || null, category || "general", recurring || null);

  return db.prepare("SELECT * FROM todo_items WHERE id = ?").get(result.lastInsertRowid);
}

export function updateTodo(catId, todoId, updates) {
  const db = getDb();
  const todo = db.prepare("SELECT * FROM todo_items WHERE id = ? AND cat_id = ?").get(todoId, catId);
  if (!todo) return null;

  const allowed = ["title", "description", "category", "recurring"];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (sets.length === 0) return todo;

  values.push(todoId, catId);
  db.prepare(`UPDATE todo_items SET ${sets.join(", ")} WHERE id = ? AND cat_id = ?`).run(...values);
  return db.prepare("SELECT * FROM todo_items WHERE id = ?").get(todoId);
}

export function completeTodo(catId, todoId) {
  const db = getDb();
  const todo = db.prepare("SELECT * FROM todo_items WHERE id = ? AND cat_id = ?").get(todoId, catId);
  if (!todo) return { error: "todo not found" };
  if (todo.status !== "active") return { error: `todo is ${todo.status}` };

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE todo_items SET status = 'completed', completed_at = ? WHERE id = ?").run(now, todoId);

  // Award rewards
  const levelResult = addXp(catId, todo.xp_reward);
  addCurrency(catId, CURRENCY, 3); // Small currency reward for todos
  const careResult = recordCareActivity(catId, todo.care_points);

  // If recurring, create the next instance
  if (todo.recurring) {
    db.prepare(`
      INSERT INTO todo_items (cat_id, title, description, category, recurring, xp_reward, care_points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(catId, todo.title, todo.description, todo.category, todo.recurring, todo.xp_reward, todo.care_points);
  }

  return {
    completed: true,
    rewards: { xp: todo.xp_reward, [CURRENCY]: 3, care_points: todo.care_points },
    leveledUp: levelResult?.leveledUp || false,
    newLevel: levelResult?.level,
    streak: careResult?.current_streak,
  };
}

export function deleteTodo(catId, todoId) {
  const db = getDb();
  const todo = db.prepare("SELECT id FROM todo_items WHERE id = ? AND cat_id = ?").get(todoId, catId);
  if (!todo) return false;
  db.prepare("UPDATE todo_items SET status = 'archived' WHERE id = ?").run(todoId);
  return true;
}
