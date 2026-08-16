import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DB_PATH = resolve(import.meta.dir, "../data/bot.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    mkdirSync(resolve(import.meta.dir, "../data"), { recursive: true });
    _db = new Database(DB_PATH, { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
