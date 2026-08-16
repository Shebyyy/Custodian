// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GuildMember, Interaction,
  ModalBuilder, TextInputBuilder, TextInputStyle, TextChannel,
} from "discord.js";
import { getDb } from "../db.js";
import { getGuildConfig, getGlobalConfig, GuildConfig, QuizQuestion } from "../config.js";
import { getOAuth2Url, hasValidToken, truncate } from "../utils.js";

/**
 * Module 3 — Verification + Authorization + Quiz Gate (Channel-Based, Multi-Server)
 *
 * Each guild has its own config. When a member joins:
 * 1. Bot assigns Unverified role (from that guild's config)
 * 2. Posts in #verification channel with Authorize + Verify buttons
 * 3. User authorizes bot (OAuth2 guilds.join scope) → stores token
 * 4. User takes quiz → pass → Verified role, fail → retry
 */
export class VerificationModule {
  private client: Client;
  private quizInProgress = new Map<string, { questionIndex: number; answers: Record<number, string>; channelId: string; guildId: string }>();

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private setupListeners() {
    // ── On member join ──
    this.client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
      const guildId = member.guild.id;
      const config = getGuildConfig(guildId);

      if (!config.isSetup || !config.roles.unverified || !config.roles.verified || !config.channels.verification) return;

      try {
        await member.roles.add(config.roles.unverified);
      } catch (err) {
        console.error(`[${guildId}] Failed to assign Unverified role to ${member.user.username}:`, err);
        return;
      }

      // Record in DB
      getDb().prepare("INSERT OR IGNORE INTO verifications (user_id, guild_id, status) VALUES (?, ?, 'pending')")
        .run(member.user.id, guildId);

      // Post verification message
      try {
        const channel = await this.client.channels.fetch(config.channels.verification);
        if (!channel || !channel.isTextBased()) return;

        const authUrl = this.buildAuthUrl(member.user.id);

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setURL(authUrl)
            .setLabel("🔗 Authorize Bot")
            .setStyle(ButtonStyle.Link)
        );

        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`verify_start:${member.user.id}:${guildId}`)
            .setLabel("✅ Verify Me")
            .setStyle(ButtonStyle.Success)
        );

        await (channel as TextChannel).send({
          content: `👋 Welcome **${member.user.username}**!\n\nPlease complete these steps to get full access:\n\n1️⃣ Click **🔗 Authorize Bot**\n2️⃣ Click **✅ Verify Me**`,
          components: [row1, row2],
        });
      } catch (err) {
        console.error(`[${guildId}] Failed to post verification message for ${member.user.username}:`, err);
      }
    });

    // ── Handle "Verify Me" button ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("verify_start:")) return;

      const parts = interaction.customId.split(":");
      const targetUserId = parts[1];
      const guildId = parts[2];

      if (interaction.user.id !== targetUserId) {
        await interaction.reply({ content: "❌ This verification is not for you!", ephemeral: true });
        return;
      }

      const config = getGuildConfig(guildId);
      const db = getDb();

      const record = db.prepare("SELECT status, attempts FROM verifications WHERE user_id = ? AND guild_id = ?")
        .get(targetUserId, guildId) as any;

      if (record?.status === "verified") {
        await interaction.reply({ content: "✅ You're already verified!", ephemeral: true });
        return;
      }

      if (record?.attempts >= config.quiz.maxAttempts) {
        await interaction.reply({ content: "❌ You've used all attempts. An admin will review your case.", ephemeral: true });
        return;
      }

      if (!hasValidToken(targetUserId)) {
        await interaction.reply({
          content: "🔒 You haven't authorized the bot yet!\n\n1. Click **🔗 Authorize Bot** above\n2. Then click **✅ Verify Me** again",
          ephemeral: true,
        });
        return;
      }

      if (!config.quiz.questions.length) {
        await interaction.reply({ content: "❌ No quiz questions configured. Admin needs to run /setup.", ephemeral: true });
        return;
      }

      db.prepare("UPDATE verifications SET agreed_to_rules_at = datetime('now'), quiz_started_at = datetime('now'), status = 'in_progress' WHERE user_id = ? AND guild_id = ?")
        .run(targetUserId, guildId);

      this.quizInProgress.set(`${targetUserId}:${guildId}`, { questionIndex: 0, answers: {}, channelId: interaction.channelId, guildId });
      // Show modal directly — can't reply then showModal
      await this.sendQuizModal(interaction, 0, guildId);
    });

    // ── Handle quiz modal submissions ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("quiz_")) return;

      const parts = interaction.customId.split("_");
      const idx = parseInt(parts[1], 10);
      const userId = parts[2];
      const guildId = parts[3];
      const answer = interaction.fields.getTextInputValue("quiz_answer");

      const stateKey = `${userId}:${guildId}`;
      const state = this.quizInProgress.get(stateKey);
      if (!state) {
        await interaction.reply({ content: "❌ No active quiz. Click 'Verify Me' to start.", ephemeral: true });
        return;
      }

      state.answers[idx] = answer;
      const config = getGuildConfig(guildId);
      const next = idx + 1;

      if (next < config.quiz.questions.length) {
        state.questionIndex = next;
        await interaction.reply({ content: `✅ Answer recorded. Next question...`, ephemeral: true });
        setTimeout(() => this.sendQuizModal(interaction, next, guildId), 500);
      } else {
        await interaction.reply({ content: "✅ All answers submitted! Grading...", ephemeral: true });
        setTimeout(() => this.grade(userId, guildId, interaction, state.answers, state.channelId), 500);
      }
    });
  }

  private buildAuthUrl(userId: string): string {
    try {
      return getOAuth2Url(userId);
    } catch {
      return "https://discord.com";
    }
  }

  private async sendQuizModal(interaction: any, idx: number, guildId: string) {
    const config = getGuildConfig(guildId);
    const q: QuizQuestion = config.quiz.questions[idx];
    if (!q) return;

    const total = config.quiz.questions.length;
    const optionsText = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("  |  ");

    const modal = new ModalBuilder()
      .setCustomId(`quiz_${idx}_${interaction.user.id}_${guildId}`)
      .setTitle(`Verification Q${idx + 1}/${total}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("quiz_answer")
            .setLabel(truncate(q.question, 45))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`Type A, B, or the answer (${optionsText})`)
            .setRequired(true)
            .setMaxLength(100)
        )
      );

    try {
      await interaction.showModal(modal);
    } catch (err) {
      console.error("Failed to show modal:", err);
    }
  }

  private async grade(userId: string, guildId: string, interaction: any, answers: Record<number, string>, channelId: string) {
    const config = getGuildConfig(guildId);
    const db = getDb();
    let correct = 0;

    for (const q of config.quiz.questions) {
      const userAns = (answers[q.id - 1] || "").trim().toLowerCase();
      const correctIdx = q.options.findIndex((o) => o.toLowerCase() === q.correctAnswer.toLowerCase());
      if (
        userAns === q.correctAnswer.toLowerCase() ||
        userAns === String(correctIdx) ||
        userAns === String.fromCharCode(65 + correctIdx)
      ) {
        correct++;
      }
    }

    const total = config.quiz.questions.length;
    const pct = Math.round((correct / total) * 100);
    const passed = pct >= config.quiz.passPercentage;
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ? AND guild_id = ?").get(userId, guildId) as any;
    const newAttempts = (record?.attempts || 0) + 1;

    try {
      if (passed) {
        db.prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now'), attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId, guildId);

        const guild = await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(config.roles.verified);
        await member.roles.remove(config.roles.unverified);

        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          await (channel as any).send(`✅ **${interaction.user.username}** passed the verification quiz! (${correct}/${total} — ${pct}%)`);
        }

        await interaction.followUp({ content: `🎉 **Passed!** ${correct}/${total} (${pct}%). You now have full access!`, ephemeral: true });
      } else {
        db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId, guildId);

        if (newAttempts < config.quiz.maxAttempts) {
          const remaining = config.quiz.maxAttempts - newAttempts;
          await interaction.followUp({
            content: `❌ **Failed** — ${correct}/${total} (${pct}%). Need ${config.quiz.passPercentage}%.\n${remaining} attempt${remaining > 1 ? "s" : ""} remaining.`,
            ephemeral: true,
          });
        } else {
          db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ? AND guild_id = ?").run(userId, guildId);
          const channel = await this.client.channels.fetch(channelId).catch(() => null);
          if (channel && channel.isTextBased()) {
            await (channel as any).send(`⚠️ **${interaction.user.username}** failed verification ${newAttempts} times. Flagged for admin review.`);
          }
          await interaction.followUp({ content: "❌ Max attempts reached. An admin will review your case.", ephemeral: true });
        }
      }
    } catch (err) {
      console.error("Grade error:", err);
    }

    this.quizInProgress.delete(`${userId}:${guildId}`);
  }

  // ─── Commands ───

  getStats(guildId: string): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE guild_id = ?").get(guildId) as any).c;
    const verified = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE guild_id = ? AND status = 'verified'").get(guildId) as any).c;
    const pending = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE guild_id = ? AND (status = 'pending' OR status = 'in_progress')").get(guildId) as any).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE guild_id = ? AND status = 'failed'").get(guildId) as any).c;
    const flagged = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE guild_id = ? AND status = 'flagged_review'").get(guildId) as any).c;
    return `🔐 **Verification:** ${total} total, ${verified} verified, ${pending} pending, ${failed} failed, ${flagged} flagged`;
  }

  async manualVerify(userId: string, guildId: string): Promise<string> {
    const config = getGuildConfig(guildId);
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      await member.roles.add(config.roles.verified);
      await member.roles.remove(config.roles.unverified);
      getDb().prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now') WHERE user_id = ? AND guild_id = ?").run(userId, guildId);
      return `✅ <@${userId}> manually verified`;
    } catch {
      return `❌ Could not verify <@${userId}>`;
    }
  }

  getFlagged(guildId: string): string {
    const users = getDb().prepare("SELECT user_id, attempts, score FROM verifications WHERE guild_id = ? AND status = 'flagged_review'").all(guildId) as any[];
    if (!users.length) return "📋 No flagged users";
    return "⚠️ **Flagged for review:**\n" + users.map((u) => `• <@${u.user_id}> — ${u.attempts} attempts, ${u.score}%`).join("\n");
  }
}
