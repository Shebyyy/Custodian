// @ts-nocheck — bun runs fine with these discord.js types
import { getDb } from "../db.js";
import { getConfig, loadChannelMappings, saveChannelMappings, ChannelMapping } from "../config.js";
import { sleep } from "../utils.js";

/**
 * Module 4 — Restore & Channel Mapping
 * Map old channels to new, restore messages via webhooks.
 */
interface StoredMessage {
  message_id: string; channel_id: string; author_id: string; author_username: string;
  content: string; attachments_json: string; timestamp: string;
  is_thread_start: number; thread_id: string; reply_to_id: string;
}

export class RestoreModule {
  private client: Client;
  constructor(client: Client) { this.client = client; }

  addMapping(source: string, target: string, isForum = false): string {
    const mappings = loadChannelMappings();
    const idx = mappings.findIndex((m) => m.sourceChannelId === source && m.isForum === isForum);
    if (idx >= 0) mappings[idx].targetChannelId = target;
    else mappings.push({ sourceChannelId: source, targetChannelId: target, isForum });
    saveChannelMappings(mappings);
    return `✅ Mapped <#${source}> → <#${target}>${isForum ? " (Forum)" : ""}`;
  }

  removeMapping(source: string): string {
    const mappings = loadChannelMappings().filter((m) => m.sourceChannelId !== source);
    saveChannelMappings(mappings);
    return `✅ Unmapped <#${source}>`;
  }

  listMappings(): string {
    const mappings = loadChannelMappings();
    if (!mappings.length) return "📋 No mappings configured";
    return "📋 **Mappings:**\n" + mappings.map((m, i) => `${i + 1}. <#${m.sourceChannelId}> → <#${m.targetChannelId}>${m.isForum ? " 📁" : ""}`).join("\n");
  }

  async preview(source: string): Promise<string> {
    const messages = getDb().prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC").all(source) as StoredMessage[];
    if (!messages.length) return `⚠️ No messages for <#${source}>`;

    const threads = new Map<string, StoredMessage[]>();
    const main: StoredMessage[] = [];
    for (const m of messages) {
      if (m.thread_id) { if (!threads.has(m.thread_id)) threads.set(m.thread_id, []); threads.get(m.thread_id)!.push(m); }
      else main.push(m);
    }
    return `🔍 **Preview for <#${source}>:**\nTotal: ${messages.length}, Main: ${main.length}, Threads: ${threads.size}`;
  }

  async restore(source: string): Promise<string> {
    const config = getConfig();
    const mapping = loadChannelMappings().find((m) => m.sourceChannelId === source);
    if (!mapping) return `⚠️ No mapping for <#${source}>. Use /restore map first.`;

    const messages = getDb().prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC").all(source) as StoredMessage[];
    if (!messages.length) return `⚠️ No messages for <#${source}>`;

    const targetChannel = await this.client.channels.fetch(mapping.targetChannelId);
    if (!targetChannel || !targetChannel.isTextBased()) return `❌ Cannot access <#${mapping.targetChannelId}>`;

    const db = getDb();
    const runId = (db.prepare("INSERT INTO restore_runs (source_channel_id, target_channel_id, total_messages, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))").run(source, mapping.targetChannelId, messages.length)).lastInsertRowid;

    let restored = 0;
    try {
      if (mapping.isForum && targetChannel.type === ChannelType.GuildForum)
        restored = await this.restoreForum(targetChannel as ForumChannel, messages, config.rateLimits.messagePostDelayMs);
      else
        restored = await this.restoreText(targetChannel as TextChannel, messages, config.rateLimits.messagePostDelayMs);
    } catch (e) { console.error("Restore error:", e); }

    db.prepare("UPDATE restore_runs SET restored_messages = ?, status = 'completed', completed_at = datetime('now') WHERE id = ?").run(restored, runId);
    return `✅ Restored ${restored}/${messages.length} messages from <#${source}> → <#${mapping.targetChannelId}>`;
  }

  private async restoreText(channel: TextChannel, messages: StoredMessage[], delay: number): Promise<number> {
    let webhook: any = null;
    try { webhook = await channel.createWebhook({ name: "Custodian" }); } catch {}

    let restored = 0;
    for (const msg of messages) {
      const date = new Date(msg.timestamp).toLocaleString();
      const atts: any[] = JSON.parse(msg.attachments_json || "[]");
      const attText = atts.length ? `\n📎 ${atts.map((a: any) => a.url).join(", ")}` : "";
      try {
        if (webhook) {
          await webhook.send({ username: msg.author_username, content: msg.content || "*empty*", threadId: msg.thread_id || undefined });
        } else {
          await channel.send(`_[Originally by **${msg.author_username}** on ${date}]_\n${msg.content}${attText}`);
        }
        restored++;
      } catch (e) { console.error(`Failed ${msg.message_id}:`, e); }
      await sleep(delay);
    }
    if (webhook) await webhook.delete().catch(() => {});
    return restored;
  }

  private async restoreForum(forum: ForumChannel, messages: StoredMessage[], delay: number): Promise<number> {
    const threads = new Map<string, StoredMessage[]>();
    const orphan: StoredMessage[] = [];
    for (const m of messages) {
      if (m.thread_id && m.is_thread_start) { if (!threads.has(m.thread_id)) threads.set(m.thread_id, []); }
      if (m.thread_id) { const g = threads.get(m.thread_id); if (g) g.push(m); }
      else orphan.push(m);
    }

    let restored = 0;
    for (const [, msgs] of threads) {
      const starter = msgs[0];
      try {
        const post = await forum.threads.create({ name: starter.content.substring(0, 60) || "Restored", message: { content: starter.content || "*empty*" }, autoArchiveDuration: 1440 });
        restored++;
        for (let i = 1; i < msgs.length; i++) {
          const r = msgs[i];
          await post.send(`_[Originally by **${r.author_username}** on ${new Date(r.timestamp).toLocaleString()}]_\n${r.content}`);
          restored++;
          await sleep(delay);
        }
        await sleep(delay);
      } catch (e) { console.error("Thread restore error:", e); }
    }
    return restored;
  }
}
