// @ts-nocheck — discord.js type quirks with bun
import { Client, GuildMember } from "discord.js";
import { getDb } from "../db.js";
import { getConfig } from "../config.js";
import { getValidAccessToken, addUserToGuild, sleep } from "../utils.js";

/**
 * Module 5 — Migration (OAuth2 Direct Add)
 *
 * Uses stored OAuth2 tokens to directly add users to a new server.
 * No invite links needed — bot calls PUT /guilds/{guild.id}/members/{user.id}
 *
 * Commands:
 * - /migrate-add <guild-id> — Add all authorized users to target server
 * - /migrate-status — Show OAuth2 token status
 */
export class MigrationModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Add all authorized users to a target guild.
   * Refreshes expired tokens automatically. Reports failures.
   */
  async migrateAdd(guildId: string, roleId?: string): Promise<string> {
    const db = getDb();
    const config = getConfig();
    const tokens = db.prepare("SELECT user_id FROM oauth_tokens").all() as any[];

    if (!tokens.length) {
      return "⚠️ No authorized users found. Users need to authorize the bot via the verification channel first.";
    }

    let added = 0;
    let failed = 0;
    let already = 0;
    const failedList: string[] = [];
    const expiredList: string[] = [];

    for (const row of tokens) {
      const userId = row.user_id;

      try {
        // Check if already in target guild
        try {
          const guild = await this.client.guilds.fetch(guildId);
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            already++;
            continue;
          }
        } catch {
          // Guild not cached or not found — try adding anyway
        }

        // Get valid token (auto-refreshes if expired)
        const accessToken = await getValidAccessToken(userId);
        if (!accessToken) {
          expiredList.push(userId);
          failed++;
          continue;
        }

        // Add user to guild
        const roles = roleId ? [roleId] : undefined;
        const success = await addUserToGuild(userId, guildId, accessToken, roles);

        if (success) {
          added++;
          console.log(`✅ Added ${userId} to ${guildId}`);
        } else {
          failedList.push(userId);
          failed++;
        }
      } catch (err: any) {
        console.error(`Error migrating ${userId}:`, err.message);
        failedList.push(userId);
        failed++;
      }

      await sleep(config.rateLimits.messagePostDelayMs);
    }

    let msg = `🚀 **Migration Complete:**\n\n` +
      `✅ **${added}** added to new server\n` +
      `🔄 **${already}** already in server\n`;

    if (failed > 0) {
      msg += `❌ **${failed}** failed\n`;
      if (expiredList.length) {
        msg += `\n⚠️ **Token expired (need re-auth):**\n${expiredList.map((id) => `• <@${id}>`).join("\n")}\n`;
      }
      if (failedList.filter((id) => !expiredList.includes(id)).length) {
        const other = failedList.filter((id) => !expiredList.includes(id));
        msg += `\n❌ **Other failures:**\n${other.map((id) => `• <@${id}>`).join("\n")}\n`;
      }
    }

    return msg;
  }

  /**
   * Show OAuth2 token status report.
   */
  getStatus(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM oauth_tokens").get() as any).c;

    const now = Date.now();
    const rows = db.prepare("SELECT user_id, expires_at FROM oauth_tokens").all() as any[];
    const valid = rows.filter((r) => new Date(r.expires_at).getTime() > now).length;
    const expired = total - valid;

    // Count members who are NOT authorized
    const members = (db.prepare("SELECT COUNT(*) as c FROM members WHERE is_active = 1").get() as any).c;
    const unauthorized = members - total;

    return `🔐 **OAuth2 Token Status:**\n\n` +
      `✅ **${valid}** valid tokens\n` +
      `⏰ **${expired}** expired tokens\n` +
      `❌ **${Math.max(0, unauthorized)}** not authorized\n\n` +
      `Total members tracked: **${members}**\n` +
      `Total authorized: **${total}**\n\n` +
      (expired > 0 ? "⚠️ Users with expired tokens will need to re-authorize.\n" : "") +
      (unauthorized > 0 ? "💡 Users who haven't verified yet need to go through the verification channel.\n" : "");
  }
}
