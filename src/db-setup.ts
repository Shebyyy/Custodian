import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../data/bot.db");

// Ensure data directory exists
mkdirSync(resolve(import.meta.dir, "../data"), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");

// ─── Migration: Add guild_id to old tables (multi-server refactor) ───
// Old databases were created before the per-guild refactor.
// CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
// We need to ALTER TABLE ADD COLUMN for each missing guild_id.

function migrateAddColumn(table: string, column: string, type: string, defaultValue: string = "''"): void {
  try {
    // Check if column exists
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    const exists = cols.some((c: any) => c.name === column);
    if (!exists) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} NOT NULL DEFAULT ${defaultValue}`).run();
      console.log(`  ↳ Added column ${column} to ${table}`);
    }
  } catch (err: any) {
    // Column might already exist or table doesn't exist — that's fine
    if (!err.message.includes("duplicate column")) {
      console.warn(`  ⚠ Could not add ${column} to ${table}: ${err.message}`);
    }
  }
}

function migrateDropIndex(table: string, indexName: string): void {
  try {
    db.prepare(`DROP INDEX IF EXISTS ${indexName}`).run();
  } catch {}
}

console.log("[Migration] Checking for missing columns...");

// backup_channels: add guild_id
migrateAddColumn("backup_channels", "guild_id", "TEXT");

// messages: add guild_id
migrateAddColumn("messages", "guild_id", "TEXT");

// members: add guild_id
migrateAddColumn("members", "guild_id", "TEXT");

// verifications: add guild_id
migrateAddColumn("verifications", "guild_id", "TEXT");

// restore_runs: add guild_id
migrateAddColumn("restore_runs", "guild_id", "TEXT");

// channel_mappings: add guild_id
migrateAddColumn("channel_mappings", "guild_id", "TEXT");

// Drop old single-column unique indexes and recreate as composite (user_id, guild_id)
try {
  const memberIdxs = db.prepare("PRAGMA index_list(members)").all() as any[];
  const oldMemberIdx = memberIdxs.find((i: any) => i.name === "idx_members_unique");
  if (oldMemberIdx) {
    const idxInfo = db.prepare(`PRAGMA index_info(idx_members_unique)`).all() as any[];
    if (idxInfo.length === 1) {
      // Old single-column index — drop and recreate as composite
      db.prepare("DROP INDEX IF EXISTS idx_members_unique").run();
      console.log("  ↳ Dropped old idx_members_unique (single column)");
    }
  }
} catch {}

try {
  const verifIdxs = db.prepare("PRAGMA index_list(verifications)").all() as any[];
  const oldVerifIdx = verifIdxs.find((i: any) => i.name === "idx_verifications_unique");
  if (oldVerifIdx) {
    const idxInfo = db.prepare(`PRAGMA index_info(idx_verifications_unique)`).all() as any[];
    if (idxInfo.length === 1) {
      db.prepare("DROP INDEX IF EXISTS idx_verifications_unique").run();
      console.log("  ↳ Dropped old idx_verifications_unique (single column)");
    }
  }
} catch {}

// ─── Per-Guild Config ───
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id TEXT PRIMARY KEY,
    roles_json TEXT DEFAULT '{}',
    channels_json TEXT DEFAULT '{}',
    quiz_json TEXT DEFAULT '{}',
    terms TEXT DEFAULT '',
    pass_percentage INTEGER DEFAULT 80,
    max_attempts INTEGER DEFAULT 3,
    is_setup INTEGER DEFAULT 0,
    setup_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Module 1: Channel Backup ───
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL DEFAULT '',
    channel_name TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL,
    author_username TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    embeds_json TEXT DEFAULT '[]',
    attachments_json TEXT DEFAULT '[]',
    timestamp TEXT NOT NULL,
    edited_timestamp TEXT,
    is_deleted INTEGER DEFAULT 0,
    reactions_json TEXT DEFAULT '[]',
    is_thread_start INTEGER DEFAULT 0,
    thread_id TEXT,
    reply_to_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
  CREATE INDEX IF NOT EXISTS idx_messages_guild ON messages(guild_id);

  CREATE TABLE IF NOT EXISTS edit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    old_content TEXT NOT NULL,
    edited_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Module 2: Member Tracking ───
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    join_date TEXT NOT NULL,
    leave_date TEXT,
    roles_json TEXT DEFAULT '[]',
    last_seen TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_members_unique ON members(user_id, guild_id);
`);

// ─── Module 3: Verification (per-guild) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'pending',
    agreed_to_rules_at TEXT,
    quiz_started_at TEXT,
    quiz_passed_at TEXT,
    attempts INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    answers_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_unique ON verifications(user_id, guild_id);
`);

// ─── Module 4: Restore (per-guild) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS restore_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL DEFAULT '',
    source_channel_id TEXT NOT NULL,
    target_channel_id TEXT NOT NULL,
    total_messages INTEGER DEFAULT 0,
    restored_messages INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL DEFAULT '',
    source_channel_id TEXT NOT NULL,
    target_channel_id TEXT NOT NULL,
    is_forum INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Module 5: OAuth2 Tokens (global — one per user, works across all guilds) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    user_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT DEFAULT '',
    expires_at TEXT NOT NULL,
    scope TEXT DEFAULT '',
    authorized_at TEXT DEFAULT (datetime('now'))
  );

  -- Pending interaction from the Authorize button click, so the OAuth2
  -- callback can update that ephemeral message with the Verify Me button.
  CREATE TABLE IF NOT EXISTS auth_pending (
    user_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    interaction_token TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log("✅ Database tables created at:", DB_PATH);
db.close();
