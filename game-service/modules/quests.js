import { getDb } from "../db.js";
import { addXp, addCurrency } from "./cats.js";
import { recordCareActivity, addEnergy } from "./care.js";

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Generate 3 daily quests for a cat, one from each of 3 different categories
export function getDailies(catId) {
  const db = getDb();
  const today = todayUTC();

  // Check if already generated today
  const existing = db.prepare("SELECT * FROM daily_quests WHERE cat_id = ? AND date = ?").all(catId, today);
  if (existing.length > 0) {
    return existing.map((dq) => {
      const template = db.prepare("SELECT * FROM daily_quest_templates WHERE id = ?").get(dq.template_id);
      return { ...dq, ...template, quest_id: dq.id, status: dq.status, completed_at: dq.completed_at };
    });
  }

  // Expire yesterday's quests
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.prepare("UPDATE daily_quests SET status = 'expired' WHERE cat_id = ? AND date = ? AND status = 'active'")
    .run(catId, yesterday);

  // Pick 3 templates from different categories
  const categories = ["social", "creative", "wellness", "exploration", "care"];
  const shuffled = categories.sort(() => Math.random() - 0.5);
  const selectedCategories = shuffled.slice(0, 3);

  const quests = [];
  for (const category of selectedCategories) {
    // Weighted random selection within category
    const templates = db.prepare("SELECT * FROM daily_quest_templates WHERE category = ?").all(category);
    if (templates.length === 0) continue;

    const totalWeight = templates.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    let picked = templates[0];
    for (const t of templates) {
      roll -= t.weight;
      if (roll <= 0) { picked = t; break; }
    }

    const result = db.prepare(
      "INSERT INTO daily_quests (cat_id, template_id, date) VALUES (?, ?, ?)"
    ).run(catId, picked.id, today);

    quests.push({
      quest_id: result.lastInsertRowid,
      ...picked,
      date: today,
      status: "active",
      completed_at: null,
    });
  }

  return quests;
}

export function completeDaily(catId, questId) {
  const db = getDb();
  const quest = db.prepare("SELECT * FROM daily_quests WHERE id = ? AND cat_id = ?").get(questId, catId);
  if (!quest) return { error: "quest not found" };
  if (quest.status !== "active") return { error: `quest is ${quest.status}` };

  const template = db.prepare("SELECT * FROM daily_quest_templates WHERE id = ?").get(quest.template_id);

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE daily_quests SET status = 'completed', completed_at = ? WHERE id = ?").run(now, questId);

  // Award rewards
  const levelResult = addXp(catId, template.xp_reward);
  addCurrency(catId, "shinies", template.currency_reward);
  const careResult = recordCareActivity(catId, template.care_points);
  if (template.energy_reward > 0) addEnergy(catId, template.energy_reward);

  return {
    completed: true,
    rewards: {
      xp: template.xp_reward,
      shinies: template.currency_reward,
      care_points: template.care_points,
      energy: template.energy_reward,
    },
    leveledUp: levelResult?.leveledUp || false,
    newLevel: levelResult?.level,
    streak: careResult?.current_streak,
  };
}
