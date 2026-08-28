// @ts-nocheck — discord.js type quirks with bun
import { Client } from "discord.js";
import { getDb } from "../db.js";
import { getValidAccessToken, addUserToGuild, sleep, DEFAULT_RATE_LIMITS } from "../utils.js";

/**
 * Module 5 — Migration (OAuth2 Direct Add)
 *
 * Uses stored OAuth2 tokens to directly add users to a new server.
 * No invite links needed — bot calls PUT /guilds/{guild.id}/members/{user.id}
 *
 * Rate limit handling:
 *   - 1.5s delay between each user add
 *   - Processes in batches of 10, pauses 3s between batches
 *   - On 429 (rate limited): stops the entire migration
 *   - On 401/403/404 (fatal): skips that user, continues
 *   - Uses rateLimitedFetch internally for automatic 429 retry
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
    const tokens = db.prepare("SELECT user_id FROM oauth_tokens").all() as any[];

    if (!tokens.length) {
      return "⚠️ No authorized users found. Users need to authorize the bot via the verification channel first.";
    }

    const rl = DEFAULT_RATE_LIMITS;
    let added = 0;
    let failed = 0;
    let already = 0;
    let rateLimited = false;
    const failedList: string[] = [];
    const expiredList: string[] = [];
    const fatalList: string[] = [];

    console.log(`[Migration] Starting migration of ${tokens.length} users to ${guildId}`);

    for (let i = 0; i < tokens.length; i++) {
      const row = tokens[i];
      const userId = row.user_id;

      // ── Batch pause: every batchSize users, wait extra ──
      if (i > 0 && i % rl.batchSize === 0) {
        console.log(`[Migration] Batch pause at user ${i}/${tokens.length} — waiting ${rl.batchPauseMs}ms`);
        await sleep(rl.batchPauseMs);
      }

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
        const result = await addUserToGuild(userId, guildId, accessToken, roles);

        if (result.success) {
          added++;
        } else if (result.reason === "rate_limited") {
          // 429 after retries — STOP the whole migration
          rateLimited = true;
          failed++;
          failedList.push(userId);
          console.error(`[Migration] Rate limited at user ${i + 1}/${tokens.length} — stopping migration`);
          break;
        } else if (result.reason === "fatal") {
          // 401/403/404 — skip, don't retry
          failed++;
          if (result.status === 401) {
            expiredList.push(userId);
          } else {
            fatalList.push(userId);
          }
        } else {
          // Other error
          failed++;
          failedList.push(userId);
        }
      } catch (err: any) {
        console.error(`[Migration] Error migrating ${userId}:`, err.message);
        failedList.push(userId);
        failed++;
      }

      // ── Delay between each user add ──
      await sleep(rl.migrationDelayMs);
    }

    // ── Build report ──
    let msg = `🚀 **Migration Complete:**\n\n` +
      `✅ **${added}** added to server\n` +
      `🔄 **${already}** already in server\n` +
      `❌ **${failed}** failed\n`;

    if (rateLimited) {
      msg += `\n⏳ **Migration stopped early — Discord rate limited us.**\nWait a few minutes and run again. Remaining users will be retried.\n`;
    }

    if (expiredList.length) {
      msg += `\n⚠️ **Token expired/invalid (need re-auth):**\n${expiredList.map((id) => `• <@${id}>`).join("\n")}\n`;
    }

    if (fatalList.length) {
      msg += `\n⛔ **Fatal errors (403/404 — skipped):**\n${fatalList.map((id) => `• <@${id}>`).join("\n")}\n`;
    }

    const otherFailed = failedList.filter((id) => !expiredList.includes(id) && !fatalList.includes(id));
    if (otherFailed.length) {
      msg += `\n❌ **Other failures:**\n${otherFailed.map((id) => `• <@${id}>`).join("\n")}\n`;
    }

    console.log(`[Migration] Done: ${added} added, ${already} skipped, ${failed} failed, rateLimited=${rateLimited}`);
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
