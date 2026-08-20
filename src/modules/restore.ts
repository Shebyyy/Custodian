// @ts-nocheck — bun runs fine with these discord.js types
import {
  Client, ChannelType, TextChannel, ForumChannel, Guild, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, Interaction, StringSelectMenuInteraction,
  ButtonInteraction, ChannelSelectMenuInteraction, ComponentType,
  MessageFlags, AttachmentBuilder,
} from "discord.js";
import { getDb } from "../db.js";
import { ChannelBackupModule } from "./channel-backup.js";
import { sleep, DEFAULT_RATE_LIMITS } from "../utils.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";

const ATTACHMENTS_DIR = resolve(import.meta.dir, "../../data/attachments");

// ─── Custom IDs for interaction flow ───
export const RESTORE_CUSTOM_IDS = {
  SELECT_SERVER: "restore_select_server",
  SELECT_SOURCE_CHANNEL: "restore_select_source_channel",
  SELECT_TARGET_CHANNEL: "restore_select_target_channel",
  BTN_MAP_ANOTHER: "restore_map_another",
  BTN_DONE: "restore_done",
  BTN_CLEAR_MAPPINGS: "restore_clear_mappings",
  BTN_CONFIRM_PURGE: "restore_confirm_purge",
} as const;

interface StoredMessage {
  message_id: string; channel_id: string; guild_id: string; author_id: string;
  author_username: string; author_bot: number; content: string; embeds_json: string;
  attachments_json: string; timestamp: string; is_deleted: number;
  reactions_json: string; is_thread_start: number; thread_id: string;
  reply_to_id: string; is_pinned: number;
}

/**
 * Module 4 — Restore (Enhanced)
 * 
 * DB-driven flow:
 *   1. /restore → shows server select menu (from backup_guilds)
 *   2. Pick server → shows backed-up channels list
 *   3. Pick source channel → shows target channel selector
 *   4. Pick target → mapping saved → option to map more or execute
 *   5. /restore execute → runs all saved mappings
 */
export class RestoreModule {
  private client: Client;
  private backupModule: ChannelBackupModule;

  constructor(client: Client, backupModule: ChannelBackupModule) {
    this.client = client;
    this.backupModule = backupModule;
  }

  // ─── Step 1: Show server select menu ───

  async startRestoreFlow(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    const guildId = interaction.guild?.id;
    if (!guildId) {
      await interaction.editReply("This command must be used in a server.");
      return;
    }

    const guilds = this.backupModule.getBackedUpGuilds();
    if (!guilds.length) {
      await interaction.editReply("No backed-up servers found in the database. Use `/backup fetch` first.");
      return;
    }

    // Build select menu options (max 25)
    const options = guilds.slice(0, 25).map((g) => ({
      label: g.name || g.guild_id,
      description: `${g.channel_count} channels · ${g.message_count} messages · ${this.formatDate(g.last_backup_at)}`,
      value: g.guild_id,
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(RESTORE_CUSTOM_IDS.SELECT_SERVER)
      .setPlaceholder("Select a source server to restore from...")
      .addOptions(options);

    const row = new ActionRowBuilder<any>().addComponents(selectMenu);

    await interaction.editReply({
      content: "**Select a source server** to restore from:",
      components: [row],
    });
  }

  // ─── Step 2: Handle server selection → show channels ───

  async handleServerSelect(interaction: StringSelectMenuInteraction, sourceGuildId: string): Promise<void> {
    const channels = this.backupModule.getBackedUpChannels(sourceGuildId);
    const guild = this.client.guilds.cache.get(sourceGuildId);
    const guildName = (channels.length ? (getDb().prepare("SELECT name FROM backup_guilds WHERE guild_id = ?").get(sourceGuildId) as any)?.name : null)
      || guild?.name || sourceGuildId;

    if (!channels.length) {
      await interaction.update({
        content: `No backed-up channels found for **${guildName}**.`,
        components: [],
      });
      return;
    }

    // Build channel list as embed
    const embed = new EmbedBuilder()
      .setTitle(`Backed-up channels in ${guildName}`)
      .setColor(0x5865F2)
      .setDescription(channels.map((ch) => {
        const typeLabel = this.channelTypeLabel(ch.type);
        const count = ch.actual_message_count ?? ch.message_count ?? 0;
        return `**#${ch.channel_name}** — ${count} messages [${typeLabel}]`;
      }).join("\n"))
      .setFooter({ text: `Select a source channel to map to a target channel` });

    // Build select menu with source channels
    const options = channels.slice(0, 25).map((ch) => ({
      label: `#${ch.channel_name}`,
      description: `${ch.actual_message_count ?? ch.message_count ?? 0} messages · ${this.channelTypeLabel(ch.type)}`,
      value: ch.channel_id,
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${RESTORE_CUSTOM_IDS.SELECT_SOURCE_CHANNEL}:${sourceGuildId}`)
      .setPlaceholder("Select a source channel...")
      .addOptions(options);

    const row = new ActionRowBuilder<any>().addComponents(selectMenu);

    await interaction.update({
      embeds: [embed],
      components: [row],
    });
  }

  // ─── Step 3: Handle source channel selection → show target channel picker ───

  async handleSourceChannelSelect(interaction: StringSelectMenuInteraction, sourceGuildId: string, sourceChannelId: string): Promise<void> {
    const db = getDb();
    const ch = db.prepare("SELECT * FROM backup_channels WHERE channel_id = ?").get(sourceChannelId) as any;

    const selectMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`${RESTORE_CUSTOM_IDS.SELECT_TARGET_CHANNEL}:${sourceGuildId}:${sourceChannelId}`)
      .setPlaceholder("Select the target channel in this server...")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum);

    const row = new ActionRowBuilder<any>().addComponents(selectMenu);

    await interaction.update({
      content: `Mapping **#${ch?.channel_name || sourceChannelId}** → select a target channel:`,
      components: [row],
    });
  }

  // ─── Step 4: Handle target channel selection → save mapping ───

  async handleTargetChannelSelect(
    interaction: ChannelSelectMenuInteraction,
    sourceGuildId: string,
    sourceChannelId: string,
    targetChannelId: string,
  ): Promise<void> {
    const db = getDb();
    const targetGuildId = interaction.guild!.id;
    const userId = interaction.user.id;

    // Check if mapping already exists
    const existing = db.prepare(
      "SELECT id FROM channel_mappings WHERE guild_id = ? AND source_channel_id = ? AND source_guild_id = ?"
    ).get(targetGuildId, sourceChannelId, sourceGuildId);

    if (existing) {
      db.prepare(`
        UPDATE channel_mappings SET target_channel_id = ?, mapped_by = ?, mapped_at = datetime('now')
        WHERE id = ?
      `).run(targetChannelId, userId, existing.id);
    } else {
      db.prepare(`
        INSERT INTO channel_mappings (guild_id, source_guild_id, source_channel_id, target_channel_id, mapped_by, mapped_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(targetGuildId, sourceGuildId, sourceChannelId, targetChannelId, userId);
    }

    const sourceCh = db.prepare("SELECT channel_name FROM backup_channels WHERE channel_id = ?").get(sourceChannelId) as any;
    const targetCh = interaction.guild!.channels.cache.get(targetChannelId);

    // Show current mappings + buttons
    const mappings = this.getMappings(targetGuildId);
    const mappingList = mappings.map((m) => {
      const srcName = db.prepare("SELECT channel_name FROM backup_channels WHERE channel_id = ?").get(m.source_channel_id) as any;
      return `• **#${srcName?.channel_name || m.source_channel_id}** → <#${m.target_channel_id}>`;
    }).join("\n");

    const doneBtn = new ButtonBuilder()
      .setCustomId(RESTORE_CUSTOM_IDS.BTN_DONE)
      .setLabel("Execute Restore")
      .setStyle(ButtonStyle.Success)
      .setEmoji("▶");

    const anotherBtn = new ButtonBuilder()
      .setCustomId(`${RESTORE_CUSTOM_IDS.BTN_MAP_ANOTHER}:${sourceGuildId}`)
      .setLabel("Map Another Channel")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("➕");

    const clearBtn = new ButtonBuilder()
      .setCustomId(RESTORE_CUSTOM_IDS.BTN_CLEAR_MAPPINGS)
      .setLabel("Clear All Mappings")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<any>().addComponents(anotherBtn, doneBtn, clearBtn);

    await interaction.update({
      content: `Mapped **#${sourceCh?.channel_name || sourceChannelId}** → **#${targetCh?.name || targetChannelId}**\n\n**Current Mappings (${mappings.length}):**\n${mappingList || "None"}`,
      components: [row],
    });
  }

  // ─── Step 4b: Map another channel ───

  async handleMapAnother(interaction: ButtonInteraction, sourceGuildId: string): Promise<void> {
    const channels = this.backupModule.getBackedUpChannels(sourceGuildId);

    const options = channels.slice(0, 25).map((ch) => ({
      label: `#${ch.channel_name}`,
      description: `${ch.actual_message_count ?? ch.message_count ?? 0} messages`,
      value: ch.channel_id,
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${RESTORE_CUSTOM_IDS.SELECT_SOURCE_CHANNEL}:${sourceGuildId}`)
      .setPlaceholder("Select another source channel...")
      .addOptions(options);

    const row = new ActionRowBuilder<any>().addComponents(selectMenu);

    await interaction.update({
      content: "**Select another source channel** to map:",
      components: [row],
    });
  }

  // ─── Step 5: Execute restore ───

  async executeRestore(interaction: ButtonInteraction): Promise<void> {
    const targetGuildId = interaction.guild!.id;
    const mappings = this.getMappings(targetGuildId);

    if (!mappings.length) {
      await interaction.update({ content: "No mappings configured. Map channels first.", components: [] });
      return;
    }

    await interaction.update({
      content: "Starting restore... This may take a while. I'll post progress updates here.",
      components: [],
    });

    const db = getDb();
    let totalRestored = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    const startTime = Date.now();

    for (const mapping of mappings) {
      const sourceCh = db.prepare("SELECT channel_name FROM backup_channels WHERE channel_id = ?").get(mapping.source_channel_id) as any;
      const targetChannel = await this.client.channels.fetch(mapping.target_channel_id).catch(() => null);
      if (!targetChannel || !(targetChannel as any).isTextBased()) {
        await interaction.followUp({ content: `Could not access target channel <#${mapping.target_channel_id}>, skipping.`, flags: MessageFlags.Ephemeral });
        continue;
      }

      // Insert restore run
      const messages = db.prepare("SELECT * FROM messages WHERE channel_id = ? AND is_deleted = 0 ORDER BY timestamp ASC").all(mapping.source_channel_id) as StoredMessage[];
      const runRes = db.prepare(
        "INSERT INTO restore_runs (guild_id, source_channel_id, target_channel_id, total_messages, status, started_at) VALUES (?, ?, ?, ?, 'running', datetime('now'))"
      ).run(targetGuildId, mapping.source_channel_id, mapping.target_channel_id, messages.length);
      const runId = Number(runRes.lastInsertRowid);

      // Progress message
      const progressMsg = await interaction.followUp({
        content: `Restoring **#${sourceCh?.channel_name || mapping.source_channel_id}** → <#${mapping.target_channel_id}>: 0/${messages.length} messages...`,
      });

      let restored = 0;
      let failed = 0;
      let skipped = 0;
      let webhook: any = null;

      try { webhook = await (targetChannel as TextChannel).createWebhook({ name: "Custodian Restore" }); } catch {}

      // Map: original message ID → new message ID (for reply chains)
      const idMap = new Map<string, string>();

      for (const msg of messages) {
        try {
          const embeds = JSON.parse(msg.embeds_json || "[]");
          const attachments = JSON.parse(msg.attachments_json || "[]");

          // Skip bot messages (optional — uncomment to skip)
          // if (msg.author_bot) { skipped++; continue; }

          const files: AttachmentBuilder[] = [];
          for (const att of attachments) {
            const localPath = this.backupModule.getAttachmentPath(msg.guild_id, msg.channel_id, msg.message_id, att.name);
            if (existsSync(localPath)) {
              try {
                const buffer = readFileSync(localPath);
                files.push(new AttachmentBuilder(buffer, { name: att.name }));
              } catch {}
            }
          }

          // Build reply reference if the referenced message was already restored
          let replyReference: any = undefined;
          if (msg.reply_to_id && idMap.has(msg.reply_to_id)) {
            replyReference = { messageId: idMap.get(msg.reply_to_id) };
          }

          const sendOptions: any = {
            username: msg.author_username,
            content: msg.content || "*empty*",
            embeds: embeds.length > 0 ? embeds : undefined,
            files: files.length > 0 ? files : undefined,
            reply: replyReference,
          };

          let sentMsg;
          if (webhook) {
            sentMsg = await webhook.send(sendOptions);
          } else {
            // Fallback: prefix with author info
            const date = new Date(msg.timestamp).toLocaleString();
            const prefix = `_[${msg.author_username} — ${date}]_\n`;
            sentMsg = await (targetChannel as TextChannel).send({
              content: `${prefix}${msg.content || "*empty*"}${attachments.length ? "\n📎 " + attachments.map((a: any) => a.name || a.url).join(", ") : ""}`,
              files: files.length > 0 ? files : undefined,
              reply: replyReference,
            });
          }

          // Track ID mapping for reply chains
          if (sentMsg) idMap.set(msg.message_id, sentMsg.id);

          // Pin if originally pinned
          if (msg.is_pinned && sentMsg) {
            try { await (targetChannel as TextChannel).messages.fetch(sentMsg.id).then((m) => m.pin()); } catch {}
          }

          restored++;

          // Update progress every 20 messages
          if (restored % 20 === 0 && progressMsg) {
            try {
              await progressMsg.edit(`Restoring **#${sourceCh?.channel_name || mapping.source_channel_id}** → <#${mapping.target_channel_id}>: ${restored}/${messages.length} messages...`);
            } catch {}
          }
        } catch (err: any) {
          console.error(`[Restore] Failed message ${msg.message_id}:`, err.message);
          failed++;
        }

        await sleep(DEFAULT_RATE_LIMITS.restoreDelayMs);
      }

      if (webhook) await webhook.delete().catch(() => {});

      // Update restore run
      db.prepare("UPDATE restore_runs SET restored_messages = ?, status = 'completed', completed_at = datetime('now') WHERE id = ?")
        .run(restored, runId);

      // Final progress update
      if (progressMsg) {
        try {
          await progressMsg.edit(
            `**${sourceCh?.channel_name || mapping.source_channel_id}** → <#${mapping.target_channel_id}>: **${restored}/${messages.length}** messages restored${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`
          );
        } catch {}
      }

      totalRestored += restored;
      totalFailed += failed;
      totalSkipped += skipped;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = `**Restore Complete**\nChannels: ${mappings.length} | Messages: ${totalRestored} restored, ${totalFailed} failed, ${totalSkipped} skipped | Time: ${elapsed}s`;
    await interaction.followUp({ content: summary });
  }

  // ─── List / Clear Mappings ───

  getMappings(targetGuildId: string): any[] {
    return getDb().prepare("SELECT * FROM channel_mappings WHERE guild_id = ? ORDER BY created_at").all(targetGuildId) as any[];
  }

  listMappings(targetGuildId: string): string {
    const db = getDb();
    const mappings = this.getMappings(targetGuildId);
    if (!mappings.length) return "No channel mappings configured for this server.";

    return "**Channel Mappings:**\n" + mappings.map((m) => {
      const srcName = db.prepare("SELECT channel_name FROM backup_channels WHERE channel_id = ?").get(m.source_channel_id) as any;
      const srcGuild = db.prepare("SELECT name FROM backup_guilds WHERE guild_id = ?").get(m.source_guild_id) as any;
      return `• **[${srcGuild?.name || "Unknown"}] #${srcName?.channel_name || m.source_channel_id}** → <#${m.target_channel_id}>`;
    }).join("\n");
  }

  clearMappings(targetGuildId: string): string {
    const count = getDb().prepare("DELETE FROM channel_mappings WHERE guild_id = ?").run(targetGuildId).changes;
    return count > 0 ? `Cleared ${count} mapping(s).` : "No mappings to clear.";
  }
  
  // ─── Preview ───

  async preview(sourceChannelId: string, count: number = 10): Promise<string> {
    const db = getDb();
    const ch = db.prepare("SELECT * FROM backup_channels WHERE channel_id = ?").get(sourceChannelId) as any;
    const messages = db.prepare("SELECT * FROM messages WHERE channel_id = ? AND is_deleted = 0 ORDER BY timestamp ASC LIMIT ?").all(sourceChannelId, count) as StoredMessage[];

    if (!messages.length) return `No backed-up messages for **#${ch?.channel_name || sourceChannelId}**.`;

    let result = `**Preview for #${ch?.channel_name || sourceChannelId}** (showing first ${messages.length}):\n\n`;
    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString();
      const botTag = msg.author_bot ? " [BOT]" : "";
      const pinTag = msg.is_pinned ? " [PINNED]" : "";
      const atts = JSON.parse(msg.attachments_json || "[]");
      const attText = atts.length ? ` [${atts.length} file(s)]` : "";
      result += `**${msg.author_username}${botTag}${pinTag}** (${date}): ${msg.content?.slice(0, 100) || "*empty*"}${attText}\n`;
    }
    return result;
  }

  // ─── Interaction Router (called from index.ts) ───

  async handleInteraction(interaction: Interaction): Promise<boolean> {
    // String Select Menus
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;

      // Step 1: Server selected
      if (customId === RESTORE_CUSTOM_IDS.SELECT_SERVER) {
        const sourceGuildId = interaction.values[0];
        await this.handleServerSelect(interaction, sourceGuildId);
        return true;
      }

      // Step 2: Source channel selected (customId includes guild ID)
      if (customId.startsWith(RESTORE_CUSTOM_IDS.SELECT_SOURCE_CHANNEL + ":")) {
        const parts = customId.split(":");
        const sourceGuildId = parts[1];
        const sourceChannelId = interaction.values[0];
        await this.handleSourceChannelSelect(interaction, sourceGuildId, sourceChannelId);
        return true;
      }
    }

    // Channel Select Menus
    if (interaction.isChannelSelectMenu()) {
      const customId = interaction.customId;
      if (customId.startsWith(RESTORE_CUSTOM_IDS.SELECT_TARGET_CHANNEL + ":")) {
        const parts = customId.split(":");
        const sourceGuildId = parts[1];
        const sourceChannelId = parts[2];
        const targetChannelId = interaction.values[0];
        await this.handleTargetChannelSelect(interaction, sourceGuildId, sourceChannelId, targetChannelId);
        return true;
      }
    }

    // Buttons
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // Map another channel
      if (customId.startsWith(RESTORE_CUSTOM_IDS.BTN_MAP_ANOTHER + ":")) {
        const sourceGuildId = customId.split(":")[1];
        await this.handleMapAnother(interaction, sourceGuildId);
        return true;
      }

      // Execute restore
      if (customId === RESTORE_CUSTOM_IDS.BTN_DONE) {
        await this.executeRestore(interaction);
        return true;
      }

      // Clear mappings
      if (customId === RESTORE_CUSTOM_IDS.BTN_CLEAR_MAPPINGS) {
        const targetGuildId = interaction.guild!.id;
        const result = this.clearMappings(targetGuildId);
        await interaction.update({ content: result, components: [] });
        return true;
      }
    }

    return false;
  }

  // ─── Helpers ───

  private channelTypeLabel(type: number): string {
    const labels: Record<number, string> = { 0: "Text", 5: "Announcement", 11: "Thread", 12: "Thread", 15: "Forum" };
    return labels[type] || `Type ${type}`;
  }

  private formatDate(iso: string | null): string {
    if (!iso) return "never";
    try { return new Date(iso).toLocaleDateString(); } catch { return "unknown"; }
  }
}
