import { Client, Events, GuildMember, PartialGuildMember } from "discord.js";
import { getDb } from "../db.js";

/**
 * Module 2 — Member Tracking
 * Tracks all members: joins, leaves, role changes, username changes.
 * Purely tracking — no DMs, no migration invites (that's handled by migration.ts now).
 */
export class MemberTrackingModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private setupListeners() {
    this.client.on(Events.GuildMemberAdd, (member: GuildMember) => {
      this.upsertMember(member, true);
    });

    this.client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
      getDb().prepare("UPDATE members SET is_active = 0, leave_date = datetime('now') WHERE user_id = ?").run(member.user.id);
    });

    this.client.on(Events.GuildMemberUpdate, (_old, nu: GuildMember | PartialGuildMember) => {
      this.upsertMember(nu as GuildMember, true);
    });
  }

  private upsertMember(member: GuildMember | PartialGuildMember, isActive: boolean) {
    getDb().prepare(`
      INSERT INTO members (user_id, username, nickname, join_date, roles_json, last_seen, is_active)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username, nickname = excluded.nickname,
        roles_json = excluded.roles_json, last_seen = excluded.last_seen,
        is_active = excluded.is_active, leave_date = NULL
    `).run(
      member.user.id, member.user.username, member.nickname || "",
      member.joinedAt?.toISOString() || new Date().toISOString(),
      JSON.stringify([...member.roles.cache.values()].map((r: any) => r.id)), isActive ? 1 : 0
    );
  }

  // ─── Commands ───

  getStats(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM members").get() as any).c;
    const active = (db.prepare("SELECT COUNT(*) as c FROM members WHERE is_active = 1").get() as any).c;
    const oauth_count = (db.prepare("SELECT COUNT(*) as c FROM oauth_tokens").get() as any).c;
    return `📊 **Members:** ${total} total, ${active} active, ${total - active} left\n🔐 **Authorized:** ${oauth_count}`;
  }
}
