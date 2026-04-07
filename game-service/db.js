import Database from "better-sqlite3";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

const DB_PATH = join(process.env.DATA_DIR || "/data", "game.db");

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      character_pubkey TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      courage INTEGER NOT NULL DEFAULT 3,
      resilience INTEGER NOT NULL DEFAULT 3,
      agility INTEGER NOT NULL DEFAULT 3,
      charm INTEGER NOT NULL DEFAULT 3,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      hp INTEGER NOT NULL DEFAULT 50,
      max_hp INTEGER NOT NULL DEFAULT 50,
      care_score INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_care_date TEXT,
      energy INTEGER NOT NULL DEFAULT 3,
      max_energy INTEGER NOT NULL DEFAULT 3,
      runs_completed INTEGER NOT NULL DEFAULT 0,
      runs_failed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cats_pubkey ON cats(pubkey);
    CREATE INDEX IF NOT EXISTS idx_cats_character_pubkey ON cats(character_pubkey);

    CREATE TABLE IF NOT EXISTS currencies (
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      currency TEXT NOT NULL DEFAULT 'shinies',
      balance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cat_id, currency)
    );

    CREATE TABLE IF NOT EXISTS trait_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      unlock_condition TEXT,
      avatar_prompt_modifier TEXT,
      rarity TEXT NOT NULL DEFAULT 'common'
    );

    CREATE TABLE IF NOT EXISTS cat_traits (
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      trait_id INTEGER NOT NULL REFERENCES trait_definitions(id),
      unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      equipped INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cat_id, trait_id)
    );

    CREATE TABLE IF NOT EXISTS item_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      slot TEXT,
      rarity TEXT NOT NULL DEFAULT 'common',
      stat_bonus_json TEXT,
      avatar_prompt_modifier TEXT,
      room_object_type TEXT,
      room_object_meta TEXT,
      shop_price INTEGER,
      image_url TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      item_def_id INTEGER NOT NULL REFERENCES item_definitions(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_cat ON inventory(cat_id);

    CREATE TABLE IF NOT EXISTS equipment (
      cat_id INTEGER NOT NULL,
      slot TEXT NOT NULL,
      inventory_id INTEGER NOT NULL REFERENCES inventory(id),
      PRIMARY KEY (cat_id, slot)
    );

    CREATE TABLE IF NOT EXISTS daily_quest_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      verification_type TEXT NOT NULL DEFAULT 'manual',
      verification_config TEXT,
      xp_reward INTEGER NOT NULL DEFAULT 10,
      currency_reward INTEGER NOT NULL DEFAULT 5,
      care_points INTEGER NOT NULL DEFAULT 1,
      energy_reward INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      template_id INTEGER NOT NULL REFERENCES daily_quest_templates(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at INTEGER,
      UNIQUE(cat_id, template_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_quests_cat_date ON daily_quests(cat_id, date);

    CREATE TABLE IF NOT EXISTS todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      recurring TEXT,
      xp_reward INTEGER NOT NULL DEFAULT 5,
      care_points INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_todo_cat ON todo_items(cat_id);

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      seed TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_node_id INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      nodes_visited INTEGER NOT NULL DEFAULT 0,
      energy_cost INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      loot_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_cat ON runs(cat_id);

    CREATE TABLE IF NOT EXISTS run_nodes (
      run_id INTEGER NOT NULL REFERENCES runs(id),
      node_id INTEGER NOT NULL,
      col INTEGER NOT NULL,
      row INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      connections_bitmask INTEGER NOT NULL DEFAULT 0,
      difficulty INTEGER NOT NULL DEFAULT 0,
      skill_tag TEXT,
      outcome_seed TEXT,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS node_outcomes (
      run_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      skill_tag TEXT,
      cat_stat INTEGER,
      roll INTEGER,
      difficulty INTEGER,
      result TEXT,
      hp_delta INTEGER NOT NULL DEFAULT 0,
      xp_gained INTEGER NOT NULL DEFAULT 0,
      score_delta INTEGER NOT NULL DEFAULT 0,
      cat_hp_after INTEGER,
      leveled_up INTEGER NOT NULL DEFAULT 0,
      item_found_id INTEGER,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS room_layouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      name TEXT NOT NULL DEFAULT 'default',
      scene TEXT NOT NULL DEFAULT 'default_studio',
      layout_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(cat_id, name)
    );

    CREATE TABLE IF NOT EXISTS published_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id INTEGER NOT NULL REFERENCES cats(id),
      milestone_type TEXT NOT NULL,
      milestone_key TEXT NOT NULL,
      nostr_event_id TEXT,
      published_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(cat_id, milestone_type, milestone_key)
    );
  `);
}
