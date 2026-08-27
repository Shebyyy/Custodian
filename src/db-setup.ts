import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../data/bot.db");

// Ensure data directory exists
mkdirSync(resolve(import.meta.dir, "../data"), { recursive: true });
mkdirSync(resolve(import.meta.dir, "../data/attachments"), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// ─── Migration Helpers ───

function migrateAddColumn(table: string, column: string, type: string, defaultValue: string = "''"): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    const exists = cols.some((c: any) => c.name === column);
    if (!exists) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} NOT NULL DEFAULT ${defaultValue}`).run();
      console.log(`  Added column ${column} to ${table}`);
    }
  } catch (err: any) {
    if (!err.message.includes("duplicate column")) {
      console.warn(`  Could not add ${column} to ${table}: ${err.message}`);
    }
  }
}

function dropSingleColumnUniqueIndexes(table: string): void {
  try {
    const idxs = db.prepare(`PRAGMA index_list(${table})`).all() as any[];
    for (const idx of idxs) {
      if (idx.unique) {
        const info = db.prepare(`PRAGMA index_info(${idx.name})`).all() as any[];
        if (info.length === 1) {
          db.prepare(`DROP INDEX IF EXISTS ${idx.name}`).run();
          console.log(`  Dropped old single-column unique index: ${idx.name} on ${table}`);
        }
      }
    }
  } catch {}
}

// --- Legacy migrations (multi-server refactor) ---
console.log("[Migration] Checking for missing columns...");
migrateAddColumn("backup_channels", "guild_id", "TEXT");
migrateAddColumn("messages", "guild_id", "TEXT");
migrateAddColumn("members", "guild_id", "TEXT");
migrateAddColumn("verifications", "guild_id", "TEXT");
migrateAddColumn("restore_runs", "guild_id", "TEXT");
migrateAddColumn("channel_mappings", "guild_id", "TEXT");
migrateAddColumn("guild_configs", "quiz_enabled", "INTEGER", "1");

dropSingleColumnUniqueIndexes("members");
dropSingleColumnUniqueIndexes("verifications");

// ──────────────────────────────────────────────────────
// BACKUP & RESTORE SYSTEM — Enhanced Schema
// ──────────────────────────────────────────────────────

// ─── backup_guilds (NEW) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_guilds (
    guild_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    icon_url TEXT DEFAULT '',
    member_count INTEGER DEFAULT 0,
    owner_id TEXT DEFAULT '',
    first_backup_at TEXT,
    last_backup_at TEXT,
    backup_enabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
console.log("  [Backup] backup_guilds table ready");

// ─── backup_channels (ENHANCED) ───
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL DEFAULT '',
    channel_name TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    type INTEGER DEFAULT 0,
    topic TEXT DEFAULT '',
    parent_id TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    nsfw INTEGER DEFAULT 0,
    slowmode INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0
  );
`);
// Add new columns to existing table if upgrading
migrateAddColumn("backup_channels", "type", "INTEGER", "0");
migrateAddColumn("backup_channels", "topic", "TEXT", "''");
migrateAddColumn("backup_channels", "parent_id", "TEXT", "''");
migrateAddColumn("backup_channels", "position", "INTEGER", "0");
migrateAddColumn("backup_channels", "nsfw", "INTEGER", "0");
migrateAddColumn("backup_channels", "slowmode", "INTEGER", "0");
migrateAddColumn("backup_channels", "message_count", "INTEGER", "0");
console.log("  [Backup] backup_channels table ready");

// ─── messages (ENHANCED — now serves as backup_messages) ───
// Already has: message_id, channel_id, guild_id, author_id, author_username, content,
//   embeds_json, attachments_json, timestamp, edited_timestamp, is_deleted,
//   reactions_json, is_thread_start, thread_id, reply_to_id, created_at
// New columns:
migrateAddColumn("messages", "author_bot", "INTEGER", "0");
migrateAddColumn("messages", "is_pinned", "INTEGER", "0");
console.log("  [Backup] messages table ready (enhanced)");

// ─── Indexes for backup queries ───
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_backup_channels_guild ON backup_channels(guild_id);
  CREATE INDEX IF NOT EXISTS idx_messages_guild ON messages(guild_id);
  CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(channel_id, is_pinned);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_backup_guilds_enabled ON backup_guilds(backup_enabled);
`);
console.log("  [Backup] indexes ready");

// ─── channel_mappings (ENHANCED for restore) ───
// Already has: id, guild_id (target), source_channel_id, target_channel_id, is_forum, created_at
// New columns:
migrateAddColumn("channel_mappings", "source_guild_id", "TEXT", "''");
migrateAddColumn("channel_mappings", "mapped_by", "TEXT", "''");
migrateAddColumn("channel_mappings", "mapped_at", "TEXT", "''");
console.log("  [Backup] channel_mappings table ready (enhanced)");

// ──────────────────────────────────────────────────────
// OTHER MODULES (unchanged)
// ──────────────────────────────────────────────────────

// --- Per-Guild Config ---
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

// --- Module 1: Messages table (already created above with enhanced columns) ---
db.exec(`
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
    author_bot INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
`);

// --- Edit history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS edit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    old_content TEXT NOT NULL,
    edited_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Module 2: Member Tracking ---
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

// --- Module 3: Verification (per-guild) ---
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

// --- Module 4: Restore (per-guild) ---
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
    source_guild_id TEXT DEFAULT '',
    mapped_by TEXT DEFAULT '',
    mapped_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Module 5: OAuth2 Tokens (global) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    user_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT DEFAULT '',
    expires_at TEXT NOT NULL,
    scope TEXT DEFAULT '',
    authorized_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auth_pending (
    user_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    interaction_token TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log("Database tables created at:", DB_PATH);
db.close();
