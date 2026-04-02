import { getDb } from "../db.js";

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function recordCareActivity(catId, carePoints) {
  const db = getDb();
  const cat = db.prepare("SELECT * FROM cats WHERE id = ?").get(catId);
  if (!cat) return null;

  const today = todayUTC();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let newStreak = cat.current_streak;
  let longestStreak = cat.longest_streak;

  if (cat.last_care_date !== today) {
    // First care activity of the day
    if (cat.last_care_date === yesterday) {
      newStreak = cat.current_streak + 1;
    } else if (!cat.last_care_date) {
      newStreak = 1;
    } else {
      // Streak broken — start fresh
      newStreak = 1;
    }
    longestStreak = Math.max(longestStreak, newStreak);
  }

  db.prepare(`
    UPDATE cats SET
      care_score = care_score + ?,
      current_streak = ?,
      longest_streak = ?,
      last_care_date = ?
    WHERE id = ?
  `).run(carePoints, newStreak, longestStreak, today, catId);

  return { care_score: cat.care_score + carePoints, current_streak: newStreak, longest_streak: longestStreak };
}

export function addEnergy(catId, amount) {
  const db = getDb();
  db.prepare(`
    UPDATE cats SET energy = MIN(energy + ?, max_energy) WHERE id = ?
  `).run(amount, catId);
}

export function spendEnergy(catId, amount) {
  const db = getDb();
  const cat = db.prepare("SELECT energy FROM cats WHERE id = ?").get(catId);
  if (!cat || cat.energy < amount) return false;
  db.prepare("UPDATE cats SET energy = energy - ? WHERE id = ?").run(amount, catId);
  return true;
}

// Called at daily reset or on first request of a new day
export function dailyEnergyRecharge(catId) {
  const db = getDb();
  const cat = db.prepare("SELECT last_care_date FROM cats WHERE id = ?").get(catId);
  if (!cat) return;

  const today = todayUTC();
  // Only grant free daily energy if we haven't already today
  // We use a simple check: if last_care_date is not today, grant +1 energy on first interaction
  // This is handled implicitly — energy rewards come from quest completion
}

export function getStreakMilestones(streak) {
  const milestones = [3, 7, 14, 30, 60, 100];
  return milestones.filter((m) => streak >= m);
}
