import { Client, Events, GuildMember, PartialGuildMember } from "discord.js";
import { getDb } from "../db.js";
import { getConfig } from "../config.js";
import { sleep } from "../utils.js";

/**
 * Module 2 — Member Tracking & Migration
 * Tracks all members, can DM everyone an invite link for server migration.
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
      JSON.stringify(member.roles.cache.map((r) => r.id)), isActive ? 1 : 0
    );
  }

  // ─── Commands ───

  getStats(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM members").get() as any).c;
    const active = (db.prepare("SELECT COUNT(*) as c FROM members WHERE is_active = 1").get() as any).c;
    return `📊 **Members:** ${total} total, ${active} active, ${total - active} left`;
  }

  async migrateInvite(inviteLink: string): Promise<string> {
    const config = getConfig();
    const db = getDb();
    const members = db.prepare("SELECT user_id, username FROM members").all() as any[];
    if (!members.length) return "⚠️ No members in database.";

    let sent = 0, failed = 0;
    const failedList: string[] = [];

    for (const m of members) {
      try {
        const user = await this.client.users.fetch(m.user_id);
        await user.send(
          `🔔 **Server Migration Notice**\n\nHey ${m.username}! Our server moved.\nJoin here: ${inviteLink}\n\n— The Team`
        );
        db.prepare("INSERT INTO migration_invites (user_id, invite_link, status, sent_at) VALUES (?, ?, 'sent', datetime('now'))").run(m.user_id, inviteLink);
        sent++;
      } catch (err: any) {
        const reason = err.code === 50007 ? "DMs closed" : err.message;
        db.prepare("INSERT INTO migration_invites (user_id, invite_link, status, sent_at, failed_reason) VALUES (?, ?, 'failed', datetime('now'), ?)").run(m.user_id, inviteLink, reason);
        failed++;
        failedList.push(m.username);
      }
      await sleep(config.rateLimits.dmDelayMs);
    }

    return `📬 **Migration:** Sent ${sent}, Failed ${failed}${failedList.length ? `\n❌ Failed: ${failedList.join(", ")}` : ""}`;
  }

  getReport(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM migration_invites").get() as any).c;
    const sent = (db.prepare("SELECT COUNT(*) as c FROM migration_invites WHERE status = 'sent'").get() as any).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM migration_invites WHERE status = 'failed'").get() as any).c;
    return `📊 **Migration Report:** ${total} DMs, ${sent} sent, ${failed} failed`;
  }
}
