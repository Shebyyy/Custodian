import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { getDb } from "./db.js";

// ─── Load .env (global secrets only) ───
function loadEnv(): Record<string, string> {
  const envPath = resolve(import.meta.dir, "../.env");
  const env: Record<string, string> = {};
  if (!existsSync(envPath)) {
    throw new Error(
      `.env not found at ${envPath}\nCreate one: cp .env.example .env\nThen set DISCORD_BOT_TOKEN`
    );
  }
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

// ─── Types ───

/** Global config (from .env — secrets, never per-guild) */
export interface GlobalConfig {
  token: string;
  clientId: string;
  oauth2: {
    clientSecret: string;
    redirectUri: string;
  };
}

/** Per-guild config (from DB) */
export interface GuildConfig {
  guildId: string;
  roles: { unverified: string; verified: string; admin: string };
  channels: { verification: string; logs: string };
  quiz: {
    enabled: boolean;
    maxAttempts: number;
    questions: QuizQuestion[];
    finalQuestion: FinalQuestion | null;
  };
  termsAndConditions: string;
  isSetup: boolean;
}

export interface QuizQuestion {
  id: number;
  question: string;
  type: "yes_no" | "multiple_choice";
  options: string[];
  correctAnswer: string;
}

export interface FinalQuestion {
  question: string;
  expectedAnswer: string;
}

export interface ChannelMapping {
  sourceChannelId: string;
  targetChannelId: string;
  isForum?: boolean;
}

// ─── Global Config (singleton) ───
let _global: GlobalConfig | null = null;

export function getGlobalConfig(): GlobalConfig {
  if (_global) return _global;

  const env = loadEnv();

  if (!env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN.startsWith("YOUR_")) {
    throw new Error("DISCORD_BOT_TOKEN not set in .env");
  }

  _global = {
    token: env.DISCORD_BOT_TOKEN,
    clientId: env.CLIENT_ID || "",
    oauth2: {
      clientSecret: env.OAUTH2_CLIENT_SECRET || "",
      redirectUri: env.OAUTH2_REDIRECT_URI || "",
    },
  };

  return _global;
}

export function setClientId(clientId: string): void {
  const g = getGlobalConfig();
  g.clientId = clientId;
}

// ─── Per-Guild Config (from DB) ───

const defaultQuestions: QuizQuestion[] = [
  { id: 1, question: "Must you follow both global and channel-specific rules?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
  { id: 2, question: "Can you ask for support in non-support channels?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
  { id: 3, question: "Which languages are allowed in this server?", type: "multiple_choice", options: ["English & Hindi", "Any language", "English only"], correctAnswer: "English & Hindi" },
  { id: 4, question: "Must you follow Discord's Community Guidelines?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
  { id: 5, question: "Does spoilable content need to be marked with context?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
  { id: 6, question: "Can you advertise without staff permission?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
  { id: 7, question: "Is impersonation allowed?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
  { id: 8, question: "Should you use common sense and not spam?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
  { id: 9, question: "Is politics allowed in the server?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
];

const defaultFinalQuestion: FinalQuestion = {
  question: "No sharing of 3rd-party extensions, repositories or APKs. Type: I will not share any third-party extensions, repos or APKs",
  expectedAnswer: "I will not share any third-party extensions, repos or APKs",
};

const defaultTerms = "";

/** Get config for a specific guild. Returns defaults if not set up yet. */
export function getGuildConfig(guildId: string): GuildConfig {
  const db = getDb();
  const row = db.prepare("SELECT * FROM guild_configs WHERE guild_id = ?").get(guildId) as any;

  if (!row) {
    return {
      guildId,
      roles: { unverified: "", verified: "", admin: "" },
      channels: { verification: "", logs: "" },
      quiz: { enabled: true, maxAttempts: 3, questions: defaultQuestions, finalQuestion: defaultFinalQuestion },
      termsAndConditions: defaultTerms,
      isSetup: false,
    };
  }

  // Parse quiz_json — handle old format (array) and new format (object)
  let quizData: { questions: QuizQuestion[]; finalQuestion: FinalQuestion | null };
  if (row.quiz_json) {
    const parsed = JSON.parse(row.quiz_json);
    if (Array.isArray(parsed)) {
      // Old format: just questions array
      quizData = { questions: parsed, finalQuestion: defaultFinalQuestion };
    } else {
      // New format: object with questions + finalQuestion
      quizData = {
        questions: parsed.questions?.length ? parsed.questions : defaultQuestions,
        finalQuestion: parsed.finalQuestion || defaultFinalQuestion,
      };
    }
  } else {
    quizData = { questions: defaultQuestions, finalQuestion: defaultFinalQuestion };
  }

  return {
    guildId,
    roles: row.roles_json ? JSON.parse(row.roles_json) : { unverified: "", verified: "", admin: "" },
    channels: (() => {
      if (!row.channels_json) return { verification: "", logs: "" };
      const c = JSON.parse(row.channels_json);
      return { verification: c.verification || "", logs: c.logs || "" };
    })(),
    quiz: {
      enabled: row.quiz_enabled ?? (row.quiz_json ? JSON.parse(row.quiz_json).enabled !== false : true),
      maxAttempts: row.max_attempts || 3,
      questions: quizData.questions,
      finalQuestion: quizData.finalQuestion,
    },
    termsAndConditions: row.terms || defaultTerms,
    isSetup: !!row.is_setup,
  };
}

/** Save config for a guild */
export function saveGuildConfig(guildId: string, data: Partial<GuildConfig>): void {
  const db = getDb();
  const existing = getGuildConfig(guildId);

  const merged: GuildConfig = { ...existing, ...data, guildId };

  db.prepare(`
    INSERT INTO guild_configs (guild_id, roles_json, channels_json, quiz_json, terms, pass_percentage, max_attempts, quiz_enabled, is_setup, setup_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(guild_id) DO UPDATE SET
      roles_json = excluded.roles_json,
      channels_json = excluded.channels_json,
      quiz_json = excluded.quiz_json,
      terms = excluded.terms,
      pass_percentage = excluded.pass_percentage,
      max_attempts = excluded.max_attempts,
      quiz_enabled = excluded.quiz_enabled,
      is_setup = 1,
      setup_at = COALESCE(guild_configs.setup_at, excluded.setup_at),
      updated_at = datetime('now')
  `).run(
    guildId,
    JSON.stringify(merged.roles),
    JSON.stringify(merged.channels),
    JSON.stringify({ enabled: merged.quiz.enabled, questions: merged.quiz.questions, finalQuestion: merged.quiz.finalQuestion }),
    merged.termsAndConditions,
    100, // all must be correct
    merged.quiz.maxAttempts,
    merged.quiz.enabled ? 1 : 0,
  );
}

// ─── Convenience alias (legacy) ───
export function getConfig(): GlobalConfig {
  return getGlobalConfig();
}
export function loadConfig(): GlobalConfig {
  return getGlobalConfig();
}
export function saveConfig(_config: any): void {
  console.warn("saveConfig is deprecated. Use saveGuildConfig(guildId, data) instead.");
}

// ─── Channel Mappings (for restore module, per-guild) ───
export function loadChannelMappings(guildId: string): ChannelMapping[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM channel_mappings WHERE guild_id = ?").all(guildId) as any[];
  return rows.map((r) => ({
    sourceChannelId: r.source_channel_id,
    targetChannelId: r.target_channel_id,
    isForum: !!r.is_forum,
  }));
}

export function saveChannelMappings(guildId: string, mappings: ChannelMapping[]): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_mappings WHERE guild_id = ?").run(guildId);
  for (const m of mappings) {
    db.prepare("INSERT INTO channel_mappings (guild_id, source_channel_id, target_channel_id, is_forum) VALUES (?, ?, ?, ?)")
      .run(guildId, m.sourceChannelId, m.targetChannelId, m.isForum ? 1 : 0);
  }
}
