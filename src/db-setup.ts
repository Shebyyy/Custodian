import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../data/bot.db");

// Ensure data directory exists
mkdirSync(resolve(import.meta.dir, "../data"), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");

// ─── Module 1: Channel Backup ───
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_channels (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    channel_id TEXT NOT NULL,
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
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    join_date TEXT NOT NULL,
    leave_date TEXT,
    roles_json TEXT DEFAULT '[]',
    last_seen TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS migration_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    invite_link TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    sent_at TEXT,
    failed_reason TEXT DEFAULT '',
    joined_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Module 3: Verification ───
db.exec(`
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending',
    agreed_to_rules_at TEXT,
    quiz_started_at TEXT,
    quiz_passed_at TEXT,
    attempts INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    answers_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Module 4: Restore ───
db.exec(`
  CREATE TABLE IF NOT EXISTS restore_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    source_channel_id TEXT NOT NULL,
    target_channel_id TEXT NOT NULL,
    is_forum INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log("✅ Database tables created at:", DB_PATH);
db.close();
