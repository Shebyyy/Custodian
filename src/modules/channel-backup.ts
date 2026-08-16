// @ts-nocheck — bun runs fine with these discord.js types
import { Client, Events, Message, PartialMessage, ThreadChannel } from "discord.js";
import { getDb } from "../db.js";

/**
 * Module 1 — Channel Backup
 * Watches registered channels, stores every message/edit/delete/reaction.
 */
export class ChannelBackupModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private setupListeners() {
    this.client.on(Events.MessageCreate, (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.isRegistered(msg.channelId)) return;
      this.storeMessage(msg);
    });

    this.client.on(Events.MessageUpdate, (old: Message | PartialMessage, nu: Message | PartialMessage) => {
      if (nu.author?.bot) return;
      if (!this.isRegistered(nu.channelId)) return;
      const oldC = old.content || "";
      const newC = nu.content || "";
      if (oldC && oldC !== newC) {
        const db = getDb();
        db.prepare("INSERT INTO edit_history (message_id, old_content, edited_at) VALUES (?, ?, datetime('now'))").run(nu.id, oldC);
        db.prepare("UPDATE messages SET content = ?, edited_timestamp = datetime('now') WHERE message_id = ?").run(newC, nu.id);
      }
    });

    this.client.on(Events.MessageDelete, (msg: Message | PartialMessage) => {
      if (msg.author?.bot) return;
      if (!this.isRegistered(msg.channelId)) return;
      getDb().prepare("UPDATE messages SET is_deleted = 1 WHERE message_id = ?").run(msg.id);
    });

    this.client.on(Events.MessageReactionAdd, (r) => {
      if (r.message.author?.bot) return;
      if (!this.isRegistered(r.message.channelId)) return;
      this.updateReactions(r.message);
    });

    this.client.on(Events.MessageReactionRemove, (r) => {
      if (r.message.author?.bot) return;
      if (!this.isRegistered(r.message.channelId)) return;
      this.updateReactions(r.message);
    });

    this.client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
      if (thread.parentId && this.isRegistered(thread.parentId)) {
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter) {
          getDb().prepare("UPDATE messages SET thread_id = ?, is_thread_start = 1 WHERE message_id = ?").run(thread.id, starter.id);
        }
      }
    });
  }

  private storeMessage(msg: Message) {
    const attachments = msg.attachments.map((a) => ({ url: a.url, name: a.name, size: a.size }));
    const reactions = msg.reactions.cache.map((r) => ({ emoji: r.emoji.name, count: r.count }));
    getDb().prepare(`
      INSERT OR REPLACE INTO messages (message_id, channel_id, author_id, author_username, content, attachments_json, timestamp, reactions_json, reply_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.channelId, msg.author.id, msg.author.username, msg.content || "", JSON.stringify(attachments), msg.createdAt.toISOString(), JSON.stringify(reactions), msg.reference?.messageId || null);
  }

  private updateReactions(msg: Message) {
    const reactions = msg.reactions.cache.map((r) => ({ emoji: r.emoji.name, count: r.count }));
    getDb().prepare("UPDATE messages SET reactions_json = ? WHERE message_id = ?").run(JSON.stringify(reactions), msg.id);
  }

  private isRegistered(channelId: string): boolean {
    return !!getDb().prepare("SELECT 1 FROM backup_channels WHERE channel_id = ?").get(channelId);
  }

  // ─── Commands ───

  addChannel(channelId: string, channelName: string): string {
    try {
      getDb().prepare("INSERT INTO backup_channels (channel_id, channel_name) VALUES (?, ?)").run(channelId, channelName);
      return `✅ Now backing up <#${channelId}>`;
    } catch {
      return `⚠️ <#${channelId}> is already being backed up`;
    }
  }

  removeChannel(channelId: string): string {
    const info = getDb().prepare("DELETE FROM backup_channels WHERE channel_id = ?").run(channelId);
    return info.changes > 0 ? `✅ Stopped backing up <#${channelId}>` : `⚠️ <#${channelId}> wasn't being backed up`;
  }

  listChannels(): string {
    const rows = getDb().prepare("SELECT * FROM backup_channels ORDER BY added_at").all() as any[];
    if (!rows.length) return "📋 No channels are being backed up.";
    return "📋 **Backed up channels:**\n" + rows.map((r, i) => `${i + 1}. <#${r.channel_id}> (${r.channel_name})`).join("\n");
  }

  exportChannel(channelId: string): { content: string; filename: string } {
    const messages = getDb().prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC").all(channelId) as any[];
    if (!messages.length) return { content: "No messages found.", filename: "empty.txt" };
    const data = JSON.stringify(messages, null, 2);
    return { content: data, filename: `backup-${channelId}.json` };
  }
}
