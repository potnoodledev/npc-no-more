import { getDb } from "./db.js";
import { loadBranding } from "./branding.js";

const branding = loadBranding();

// Default care quests (theme-neutral). Override via branding.json questTemplates.care
const DEFAULT_CARE_QUESTS = [
  { title: "Feed Your Character", description: "Time for a meal! Give them some love.", xp_reward: 10, currency_reward: 5, care_points: 2, energy_reward: 1 },
  { title: "Groom Your Character", description: "A little pampering goes a long way.", xp_reward: 10, currency_reward: 5, care_points: 2, energy_reward: 0 },
  { title: "Play Together", description: "Have some fun together.", xp_reward: 10, currency_reward: 5, care_points: 2, energy_reward: 1 },
  { title: "Nap Together", description: "Sometimes the best thing you can do is rest.", xp_reward: 5, currency_reward: 3, care_points: 3, energy_reward: 1 },
];

function getCareQuests() {
  const custom = branding.questTemplates?.care;
  if (custom?.length) return custom.map(q => ({ ...q, category: "care", verification_type: "manual" }));
  return DEFAULT_CARE_QUESTS.map(q => ({ ...q, category: "care", verification_type: "manual" }));
}

export function seedIfEmpty() {
  const db = getDb();

  const templateCount = db.prepare("SELECT COUNT(*) as n FROM daily_quest_templates").get().n;
  if (templateCount > 0) return;

  console.log("[seed] Inserting daily quest templates...");

  const templates = [
    // Social
    { title: "Say Hello", description: "Post a greeting or shoutout on the feed", category: "social", verification_type: "manual", xp_reward: 10, currency_reward: 5, care_points: 1, energy_reward: 1 },
    { title: "Room Hangout", description: "Visit someone's room and say hi", category: "social", verification_type: "room_visit", xp_reward: 10, currency_reward: 5, care_points: 1, energy_reward: 0 },
    { title: "Reply to a Friend", description: "Reply to someone else's post in a thread", category: "social", verification_type: "manual", xp_reward: 10, currency_reward: 5, care_points: 1, energy_reward: 0 },
    { title: "Send a DM", description: "Send a kind message to someone", category: "social", verification_type: "manual", xp_reward: 10, currency_reward: 5, care_points: 1, energy_reward: 0 },

    // Creative
    { title: "Post Something", description: "Share a thought, story, or musing on the feed", category: "creative", verification_type: "manual", xp_reward: 15, currency_reward: 8, care_points: 2, energy_reward: 1 },
    { title: "Write a Journal Entry", description: "Write something reflective — a memory, a feeling, a dream", category: "creative", verification_type: "manual", xp_reward: 15, currency_reward: 8, care_points: 2, energy_reward: 1 },
    { title: "Make Some Art", description: "Generate or create an image, sketch, or visual piece", category: "creative", verification_type: "manual", xp_reward: 15, currency_reward: 10, care_points: 2, energy_reward: 0 },
    { title: "Tell a Story", description: "Write a short story or scene from your character's perspective", category: "creative", verification_type: "manual", xp_reward: 20, currency_reward: 10, care_points: 2, energy_reward: 1 },

    // Wellness
    { title: "Take a Break", description: "Step away from the screen for 10 minutes. You deserve it.", category: "wellness", verification_type: "manual", xp_reward: 10, currency_reward: 5, care_points: 2, energy_reward: 1 },
    { title: "Hydration Check", description: "Drink a glass of water right now", category: "wellness", verification_type: "manual", xp_reward: 5, currency_reward: 3, care_points: 1, energy_reward: 0 },
    { title: "Stretch Break", description: "Stand up and stretch for a minute or two", category: "wellness", verification_type: "manual", xp_reward: 5, currency_reward: 3, care_points: 1, energy_reward: 0 },
    { title: "Deep Breaths", description: "Take 5 slow, deep breaths. In through the nose, out through the mouth.", category: "wellness", verification_type: "manual", xp_reward: 5, currency_reward: 3, care_points: 2, energy_reward: 1 },
    { title: "Mood Check-in", description: "How are you feeling right now? Acknowledge it without judgment.", category: "wellness", verification_type: "manual", xp_reward: 10, currency_reward: 5, care_points: 2, energy_reward: 0 },

    // Exploration
    { title: "Visit a New Room", description: "Check out a room you haven't visited before", category: "exploration", verification_type: "room_visit", xp_reward: 15, currency_reward: 8, care_points: 1, energy_reward: 0 },
    { title: "Chat with the Agent", description: "Have a conversation with your Pi Agent", category: "exploration", verification_type: "agent_chat", xp_reward: 10, currency_reward: 5, care_points: 1, energy_reward: 0 },
    { title: "Try Something New", description: "Do something in the app you haven't done before", category: "exploration", verification_type: "manual", xp_reward: 15, currency_reward: 8, care_points: 1, energy_reward: 1 },

    // Care (from branding config)
    ...getCareQuests(),
  ];

  const insert = db.prepare(`
    INSERT INTO daily_quest_templates (title, description, category, verification_type, xp_reward, currency_reward, care_points, energy_reward, weight)
    VALUES (@title, @description, @category, @verification_type, @xp_reward, @currency_reward, @care_points, @energy_reward, 1)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  insertMany(templates);
  console.log(`[seed] Inserted ${templates.length} quest templates`);
}
