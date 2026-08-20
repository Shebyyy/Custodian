// @ts-nocheck — bun runs fine with these discord.js types
import {
  Client, Events, Message, PartialMessage, ThreadChannel, Guild, TextBasedChannel,
  ChannelType, Embed, Attachment, MessagePin, Collection,
} from "discord.js";
import { getDb } from "../db.js";
import { sleep } from "../utils.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ATTACHMENTS_DIR = resolve(import.meta.dir, "../../data/attachments");

/**
 * Module 1 — Channel Backup (Enhanced)
 * 
 * - Per-guild backup enable/disable
 * - Historical backfill (fetch old messages)
 * - Real-time capture: messages, edits, deletes, embeds, pins, threads, attachments
 * - Attachment downloading to local filesystem
 * - Channel & guild metadata storage
 */
export class ChannelBackupModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  // ─── Backup Enable/Disable ───

  enableBackup(guild: Guild): string {
    const db = getDb();
    db.prepare(`
      INSERT INTO backup_guilds (guild_id, name, icon_url, member_count, owner_id, backup_enabled, first_backup_at, last_backup_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(guild_id) DO UPDATE SET
        name = excluded.name,
        icon_url = excluded.icon_url,
        member_count = excluded.member_count,
        owner_id = excluded.owner_id,
        backup_enabled = 1,
        last_backup_at = datetime('now'),
        updated_at = datetime('now')
    `).run(
      guild.id,
      guild.name,
      guild.iconURL() || "",
      guild.memberCount,
      guild.ownerId,
    );
    return `Backup enabled for **${guild.name}**. Use /backup fetch to backfill old messages.`;
  }

  disableBackup(guildId: string): string {
    const db = getDb();
    const row = db.prepare("SELECT name FROM backup_guilds WHERE guild_id = ?").get(guildId) as any;
    if (!row) return "Backup is not enabled for this server.";
    db.prepare("UPDATE backup_guilds SET backup_enabled = 0, updated_at = datetime('now') WHERE guild_id = ?").run(guildId);
    return `Backup disabled for **${row.name}**. Existing data is preserved.`;
  }

  isBackupEnabled(guildId: string): boolean {
    const row = getDb().prepare("SELECT backup_enabled FROM backup_guilds WHERE guild_id = ?").get(guildId) as any;
    return !!row?.backup_enabled;
  }

  // ─── Status & Stats ───

  getStatusEmbed(guildId: string): any {
    const db = getDb();
    const guild = db.prepare("SELECT * FROM backup_guilds WHERE guild_id = ?").get(guildId) as any;
    if (!guild) return { content: "Backup is not configured for this server." };

    const channels = db.prepare("SELECT * FROM backup_channels WHERE guild_id = ? ORDER BY position").all(guildId) as any[];
    const totalMessages = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE guild_id = ? AND is_deleted = 0").get(guildId) as any;
    const deletedMessages = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE guild_id = ? AND is_deleted = 1").get(guildId) as any;
    const threads = channels.filter((c) => c.type === ChannelType.PublicThread || c.type === ChannelType.PrivateThread || c.type === 11);
    const textChannels = channels.filter((c) => c.type === ChannelType.GuildText || c.type === 0);
    const announcementChannels = channels.filter((c) => c.type === ChannelType.GuildAnnouncement || c.type === 5);

    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle(`Backup Status — ${guild.name}`)
      .setColor(guild.backup_enabled ? 0x57F287 : 0xED4245)
      .addFields(
        { name: "State", value: guild.backup_enabled ? "Active" : "Disabled", inline: true },
        { name: "Total Messages", value: `${totalMessages?.cnt || 0}`, inline: true },
        { name: "Deleted", value: `${deletedMessages?.cnt || 0}`, inline: true },
        { name: "Channels", value: `${channels.length} total (${textChannels.length} text, ${announcementChannels.length} announcement, ${threads.length} threads)`, inline: true },
        { name: "First Backup", value: this.formatDate(guild.first_backup_at), inline: true },
        { name: "Last Backup", value: this.formatDate(guild.last_backup_at), inline: true },
      );

    // Add channel breakdown as fields (max 25 fields = 25 channels)
    const maxChannels = 20; // leave room for the 6 summary fields above
    const shownChannels = channels.slice(0, maxChannels);
    for (const ch of shownChannels) {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND is_deleted = 0").get(ch.channel_id) as any;
      const typeLabel = this.channelTypeLabel(ch.type);
      embed.addFields({
        name: `#${ch.channel_name}`,
        value: `${count?.cnt || 0} messages [${typeLabel}]`,
        inline: true,
      });
    }

    if (channels.length > maxChannels) {
      embed.addFields({ name: "...", value: `+ ${channels.length - maxChannels} more channels`, inline: false });
    }

    if (channels.length > maxChannels) {
      const csv = 'Channel,Messages,Type\n' + channels.map((ch) => {
        const count = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND is_deleted = 0').get(ch.channel_id) as any;
        return ch.channel_name + ',' + (count?.cnt || 0) + ',' + this.channelTypeLabel(ch.type);
      }).join('\n');
      return {
        embeds: [embed],
        files: [{ attachment: Buffer.from(csv, 'utf-8'), name: 'backup-status-' + guildId + '.csv' }],
      };
    }


    return { embeds: [embed] };
  }

  private formatDate(iso: string | null): string {
    if (!iso) return "N/A";
    try { return new Date(iso).toLocaleDateString(); } catch { return "unknown"; }
  }

  // ─── Historical Backfill ───

  async fetchHistorical(guild: Guild, targetChannel?: TextBasedChannel): Promise<string> {
    const db = getDb();
    const channels: TextBasedChannel[] = [];

    if (targetChannel) {
      if (!this.isTextChannel(targetChannel)) return "That channel type cannot be backed up.";
      channels.push(targetChannel);
    } else {
      guild.channels.cache.forEach((ch) => {
        if (this.isTextChannel(ch)) channels.push(ch as TextBasedChannel);
      });
    }

    if (!channels.length) return "No backupable channels found.";

    // Ensure guild is registered
    this.enableBackup(guild);

    // Store channel metadata
    for (const ch of channels) {
      this.storeChannelMetadata(ch as any);
    }

    const results: string[] = [];
    let totalFetched = 0;

    for (const ch of channels) {
      const channelName = (ch as any).name || ch.id;
      const fetched = await this.fetchChannelMessages(ch as any);
      totalFetched += fetched;
      results.push(`  #${channelName}: ${fetched} messages`);
    }

    // Update guild last_backup_at
    db.prepare("UPDATE backup_guilds SET last_backup_at = datetime('now'), updated_at = datetime('now') WHERE guild_id = ?").run(guild.id);

    // Update message counts for each channel
    for (const ch of channels) {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ? AND is_deleted = 0").get(ch.id) as any;
      db.prepare("UPDATE backup_channels SET message_count = ? WHERE channel_id = ?").run(count?.cnt || 0, ch.id);
    }

    return `Backfill complete for ${channels.length} channel(s).\n${results.join("\n")}\nTotal: **${totalFetched}** messages fetched.`;
  }

  private async fetchChannelMessages(channel: any): Promise<number> {
    const channelId = channel.id;
    let fetched = 0;
    let lastId: string | undefined;
    let empty = false;

    while (!empty) {
      const options: any = { limit: 100 };
      if (lastId) options.before = lastId;

      try {
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) {
          empty = true;
          break;
        }

        for (const [, msg] of messages) {
          this.storeMessageFull(msg);
          fetched++;
          lastId = msg.id;
        }

        console.log(`[Backup] Fetched ${messages.size} messages from #${channel.name} (total: ${fetched})`);
      } catch (err: any) {
        console.error(`[Backup] Error fetching from #${channel.name}:`, err.message);
        // If we got some messages, continue; otherwise stop
        if (fetched === 0) break;
        empty = true;
      }

      // Rate limit: small delay between fetches
      await sleep(250);
    }

    // Fetch threads in this channel
    if (channel.threads) {
      try {
        const activeThreads = await channel.threads.fetchActive();
        for (const [, thread] of activeThreads.threads) {
          this.storeChannelMetadata(thread as any);
          const threadFetched = await this.fetchChannelMessages(thread);
          fetched += threadFetched;
        }

        // Fetch archived threads too
        const archivedThreads = await channel.threads.fetchArchived({ fetchAll: true }).catch(() => null);
        if (archivedThreads) {
          for (const [, thread] of archivedThreads.threads) {
            this.storeChannelMetadata(thread as any);
            const threadFetched = await this.fetchChannelMessages(thread);
            fetched += threadFetched;
          }
        }
      } catch (err: any) {
        console.warn(`[Backup] Could not fetch threads for #${channel.name}:`, err.message);
      }
    }

    return fetched;
  }

  // ─── Purge ───

  purgeBackup(guildId: string): { channelCount: number; messageCount: number } {
    const db = getDb();
    const channels = db.prepare("SELECT channel_id FROM backup_channels WHERE guild_id = ?").all(guildId) as any[];
    const channelIds = channels.map((c) => c.channel_id);

    let messageCount = 0;
    for (const chId of channelIds) {
      const result = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?").get(chId) as any;
      messageCount += result?.cnt || 0;
      db.prepare("DELETE FROM messages WHERE channel_id = ?").run(chId);
      db.prepare("DELETE FROM edit_history WHERE message_id IN (SELECT message_id FROM messages WHERE channel_id = ?)").run(chId);
    }
    db.prepare("DELETE FROM backup_channels WHERE guild_id = ?").run(guildId);
    db.prepare("DELETE FROM backup_guilds WHERE guild_id = ?").run(guildId);
    db.prepare("DELETE FROM channel_mappings WHERE guild_id = ? OR source_guild_id = ?").run(guildId, guildId);

    return { channelCount: channels.length, messageCount };
  }

  // ─── Get backed-up guilds (for restore flow) ───

  getBackedUpGuilds(): any[] {
    return getDb().prepare(`
      SELECT bg.*,
        (SELECT COUNT(*) FROM backup_channels WHERE guild_id = bg.guild_id) as channel_count,
        (SELECT COUNT(*) FROM messages WHERE guild_id = bg.guild_id AND is_deleted = 0) as message_count
      FROM backup_guilds bg
      WHERE channel_count > 0
      ORDER BY bg.last_backup_at DESC
    `).all() as any[];
  }

  getBackedUpChannels(guildId: string): any[] {
    return getDb().prepare(`
      SELECT bc.*,
        (SELECT COUNT(*) FROM messages WHERE channel_id = bc.channel_id AND is_deleted = 0) as actual_message_count
      FROM backup_channels bc
      WHERE bc.guild_id = ?
      ORDER BY bc.position
    `).all(guildId) as any[];
  }

  // ─── Event Listeners ───

  private setupListeners() {
    // --- New Message ---
    this.client.on(Events.MessageCreate, (msg: Message) => {
      if (!msg.guild) return;
      if (!this.isBackupEnabled(msg.guild.id)) return;
      // Store bot messages too for completeness, but flag them
      this.storeMessageFull(msg);
      this.touchGuild(msg.guild.id);
    });

    // --- Message Edit ---
    this.client.on(Events.MessageUpdate, (old: Message | PartialMessage, nu: Message | PartialMessage) => {
      if (!nu.guild) return;
      if (!this.isBackupEnabled(nu.guild.id)) return;
      const oldC = old.content || "";
      const newC = nu.content || "";
      if (oldC && oldC !== newC) {
        const db = getDb();
        db.prepare("INSERT INTO edit_history (message_id, old_content, edited_at) VALUES (?, ?, datetime('now'))").run(nu.id, oldC);
        db.prepare("UPDATE messages SET content = ?, edited_timestamp = datetime('now'), embeds_json = ? WHERE message_id = ?")
          .run(newC, JSON.stringify(nu.embeds?.map(e => this.serializeEmbed(e)) || []), nu.id);
      }
      this.touchGuild(nu.guild!.id);
    });

    // --- Message Delete ---
    this.client.on(Events.MessageDelete, (msg: Message | PartialMessage) => {
      if (!msg.guild) return;
      if (!this.isBackupEnabled(msg.guild.id)) return;
      getDb().prepare("UPDATE messages SET is_deleted = 1 WHERE message_id = ?").run(msg.id);
    });

    // --- Bulk Delete ---
    this.client.on(Events.MessageDeleteBulk, (messages: Collection<string, Message | PartialMessage>) => {
      if (!messages.first()?.guild) return;
      const guildId = messages.first()!.guild!.id;
      if (!this.isBackupEnabled(guildId)) return;
      const db = getDb();
      const stmt = db.prepare("UPDATE messages SET is_deleted = 1 WHERE message_id = ?");
      for (const [, msg] of messages) {
        stmt.run(msg.id);
      }
    });

    // --- Reactions ---
    this.client.on(Events.MessageReactionAdd, (r) => {
      if (!r.message.guild) return;
      if (!this.isBackupEnabled(r.message.guild.id)) return;
      this.updateReactions(r.message);
    });

    this.client.on(Events.MessageReactionRemove, (r) => {
      if (!r.message.guild) return;
      if (!this.isBackupEnabled(r.message.guild.id)) return;
      this.updateReactions(r.message);
    });

    // --- Thread Create ---
    this.client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
      if (!thread.parentId || !thread.guild) return;
      if (!this.isBackupEnabled(thread.guild.id)) return;
      this.storeChannelMetadata(thread as any);
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) {
        getDb().prepare("UPDATE messages SET thread_id = ?, is_thread_start = 1 WHERE message_id = ?")
          .run(thread.id, starter.id);
      }
    });

    // --- Channel Create ---
    this.client.on(Events.ChannelCreate, (ch) => {
      if (!ch.guild || !this.isBackupEnabled(ch.guild.id)) return;
      if (this.isTextChannel(ch)) this.storeChannelMetadata(ch as any);
    });

    // --- Channel Update ---
    this.client.on(Events.ChannelUpdate, (oldCh, newCh) => {
      if (!newCh.guild || !this.isBackupEnabled(newCh.guild.id)) return;
      if (this.isTextChannel(newCh)) this.storeChannelMetadata(newCh as any);
    });

    // --- Pin Add/Remove ---
    this.client.on(Events.MessagePinsAdd, (pin: MessagePin) => {
      if (!pin.guild || !this.isBackupEnabled(pin.guild.id)) return;
      getDb().prepare("UPDATE messages SET is_pinned = 1 WHERE message_id = ?").run(pin.messageId);
    });
  }

  // ─── Message Storage (Full) ───

  private storeMessageFull(msg: Message) {
    const db = getDb();
    const attachments = msg.attachments.map((a: Attachment) => ({
      url: a.url,
      proxyUrl: a.proxyURL || "",
      name: a.name,
      size: a.size,
      contentType: a.contentType || "",
      description: a.description || "",
      height: a.height || null,
      width: a.width || null,
    }));

    const embeds = msg.embeds.map((e: Embed) => this.serializeEmbed(e));
    const reactions = msg.reactions.cache.map((r) => ({
      emoji: r.emoji.name || r.emoji.identifier,
      count: r.count,
      me: r.me,
    }));

    // Download attachments in background
    for (const att of msg.attachments.values()) {
      this.downloadAttachment(msg.guild!.id, msg.channelId, msg.id, att).catch(() => {});
    }

    db.prepare(`
      INSERT OR REPLACE INTO messages (
        message_id, channel_id, guild_id, author_id, author_username, author_bot,
        content, embeds_json, attachments_json, timestamp, edited_timestamp,
        is_deleted, reactions_json, is_thread_start, thread_id, reply_to_id, is_pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.channelId,
      msg.guild?.id || "",
      msg.author.id,
      msg.author.displayName || msg.author.username,
      msg.author.bot ? 1 : 0,
      msg.content || "",
      JSON.stringify(embeds),
      JSON.stringify(attachments),
      msg.createdAt.toISOString(),
      msg.editedAt?.toISOString() || null,
      0,
      JSON.stringify(reactions),
      msg.hasThread ? 1 : 0,
      msg.thread?.id || null,
      msg.reference?.messageId || null,
      msg.pinned ? 1 : 0,
    );

    // Update channel message count
    db.prepare("UPDATE backup_channels SET message_count = (SELECT COUNT(*) FROM messages WHERE channel_id = ? AND is_deleted = 0) WHERE channel_id = ?")
      .run(msg.channelId, msg.channelId);
  }

  // ─── Channel Metadata Storage ───

  private storeChannelMetadata(ch: any) {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO backup_channels (
        channel_id, guild_id, channel_name, added_at, type, topic, parent_id, position, nsfw, slowmode, message_count
      ) VALUES (?, ?, ?, COALESCE((SELECT added_at FROM backup_channels WHERE channel_id = ?), datetime('now')), ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT COUNT(*) FROM messages WHERE channel_id = ? AND is_deleted = 0), 0)
      )
    `).run(
      ch.id,
      ch.guild?.id || ch.guildId || "",
      ch.name || ch.id,
      ch.id, // for COALESCE subquery
      ch.type ?? 0,
      ch.topic || "",
      ch.parentId || "",
      ch.position ?? 0,
      ch.nsfw ? 1 : 0,
      ch.rateLimitPerUser ?? 0,
      ch.id, // for COALESCE subquery
    );
  }

  // ─── Attachment Download ───

  private async downloadAttachment(guildId: string, channelId: string, messageId: string, attachment: Attachment): Promise<void> {
    try {
      const dir = join(ATTACHMENTS_DIR, guildId, channelId, messageId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const filePath = join(dir, attachment.name || "unknown");
      if (existsSync(filePath)) return; // Already downloaded

      const response = await fetch(attachment.url);
      if (!response.ok) return;

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      console.log(`[Backup] Downloaded attachment: ${attachment.name} (${(buffer.length / 1024).toFixed(1)}KB)`);
    } catch (err: any) {
      console.warn(`[Backup] Failed to download attachment ${attachment.name}: ${err.message}`);
    }
  }

  getAttachmentPath(guildId: string, channelId: string, messageId: string, filename: string): string {
    return join(ATTACHMENTS_DIR, guildId, channelId, messageId, filename);
  }

  // ─── Reaction Updates ───

  private updateReactions(msg: Message) {
    const reactions = msg.reactions.cache.map((r) => ({
      emoji: r.emoji.name || r.emoji.identifier,
      count: r.count,
      me: r.me,
    }));
    getDb().prepare("UPDATE messages SET reactions_json = ? WHERE message_id = ?")
      .run(JSON.stringify(reactions), msg.id);
  }

  // ─── Helpers ───

  private touchGuild(guildId: string) {
    getDb().prepare("UPDATE backup_guilds SET last_backup_at = datetime('now') WHERE guild_id = ? AND backup_enabled = 1").run(guildId);
  }

  private isTextChannel(ch: any): boolean {
    const t = ch.type;
    // GuildText (0), GuildAnnouncement (5), PublicThread (11), PrivateThread (12), GuildForum (15)
    return [0, 5, 11, 12, 15].includes(t);
  }

  private serializeEmbed(e: Embed): any {
    return {
      type: e.type,
      title: e.title || null,
      description: e.description || null,
      url: e.url || null,
      color: e.color || null,
      timestamp: e.timestamp || null,
      footer: e.footer ? { text: e.footer.text, iconUrl: e.footer.iconURL } : null,
      image: e.image ? { url: e.image.url, proxyUrl: e.image.proxyURL, width: e.image.width, height: e.image.height } : null,
      thumbnail: e.thumbnail ? { url: e.thumbnail.url, proxyUrl: e.thumbnail.proxyURL, width: e.thumbnail.width, height: e.thumbnail.height } : null,
      video: e.video ? { url: e.video.url, proxyUrl: e.video.proxyURL, width: e.video.width, height: e.video.height } : null,
      provider: e.provider ? { name: e.provider.name, url: e.provider.url } : null,
      author: e.author ? { name: e.author.name, url: e.author.url, iconUrl: e.author.iconURL, proxyIconUrl: e.author.proxyIconURL } : null,
      fields: e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline })),
    };
  }

  private channelTypeLabel(type: number): string {
    const labels: Record<number, string> = {
      0: "Text", 5: "Announcement", 11: "Public Thread", 12: "Private Thread", 15: "Forum",
    };
    return labels[type] || `Type ${type}`;
  }

  exportChannel(channelId: string): { content: string; filename: string } {
    const messages = getDb().prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC").all(channelId) as any[];
    if (!messages.length) return { content: "No messages found.", filename: "empty.txt" };
    const data = JSON.stringify(messages, null, 2);
    return { content: data, filename: `backup-${channelId}.json` };
  }

  // Legacy compat — used by old commands
  addChannel(channelId: string, channelName: string, guildId?: string): string {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO backup_channels (channel_id, guild_id, channel_name) VALUES (?, ?, ?)").run(channelId, guildId || "", channelName);
    return `Now backing up <#${channelId}>`;
  }

  removeChannel(channelId: string): string {
    const info = getDb().prepare("DELETE FROM backup_channels WHERE channel_id = ?").run(channelId);
    return info.changes > 0 ? `Stopped backing up <#${channelId}>` : `<#${channelId}> wasn't being backed up`;
  }

  listChannels(guildId?: string): string {
    const db = getDb();
    const rows = guildId
      ? db.prepare("SELECT * FROM backup_channels WHERE guild_id = ? ORDER BY added_at").all(guildId) as any[]
      : db.prepare("SELECT * FROM backup_channels ORDER BY added_at").all() as any[];
    if (!rows.length) return "No channels are being backed up.";
    return "**Backed up channels:**\n" + rows.map((r, i) => `${i + 1}. <#${r.channel_id}> (${r.channel_name})`).join("\n");
  }
}
