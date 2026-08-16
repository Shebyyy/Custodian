// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GuildMember, Interaction,
  ModalBuilder, TextInputBuilder, TextInputStyle, TextChannel,
} from "discord.js";
import { getDb } from "../db.js";
import { getConfig, QuizQuestion } from "../config.js";
import { getOAuth2Url, hasValidToken, truncate } from "../utils.js";

/**
 * Module 3 — Verification + Authorization + Quiz Gate (Channel-Based)
 *
 * Flow:
 * 1. User joins → Unverified role assigned → bot posts in #verification
 * 2. Message has 2 buttons:
 *    - 🔗 Authorize Bot (Link button → opens Discord OAuth2 page)
 *    - ✅ Verify Me (Regular button → starts quiz, only if authorized)
 * 3. User clicks Authorize → browser → Discord auth → callback → token stored
 * 4. User clicks Verify Me → check authorized → quiz modals → grade → Verified role
 *
 * NO DMs. Everything in the verification channel.
 */
export class VerificationModule {
  private client: Client;
  private quizInProgress = new Map<string, { questionIndex: number; answers: Record<number, string>; channelId: string }>();

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private setupListeners() {
    // ── On member join: assign Unverified role + post verification message ──
    this.client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
      const config = getConfig();
      if (!config.roles.unverified || !config.roles.verified || !config.channels.verification) return;

      try {
        await member.roles.add(config.roles.unverified);
      } catch (err) {
        console.error(`Failed to assign Unverified role to ${member.user.username}:`, err);
        return;
      }

      // Record in DB
      getDb().prepare("INSERT OR IGNORE INTO verifications (user_id, status) VALUES (?, 'pending')").run(member.user.id);

      // Check if already authorized & verified from a previous server
      const isAuthorized = hasValidToken(member.user.id);
      const prevRecord = getDb().prepare("SELECT status FROM verifications WHERE user_id = ?").get(member.user.id) as any;

      // Post verification prompt in the channel
      try {
        const channel = await this.client.channels.fetch(config.channels.verification);
        if (!channel || !channel.isTextBased()) return;

        const authUrl = this.buildAuthUrl(member.user.id);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setURL(authUrl)
            .setLabel("🔗 Authorize Bot")
            .setStyle(ButtonStyle.Link)
        );

        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`verify_start:${member.user.id}`)
            .setLabel(isAuthorized ? "✅ Verify Me" : "🔒 Verify Me (Authorize First)")
            .setStyle(isAuthorized ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!isAuthorized),
        );

        let statusNote = "";
        if (prevRecord?.status === "verified") {
          statusNote = "\n\n✅ *You were previously verified — but you still need to verify here.*";
        } else if (isAuthorized) {
          statusNote = "\n\n✅ *Bot authorized! Click **Verify Me** to take the quiz.*";
        } else {
          statusNote = "\n\n🔗 *Click **Authorize Bot** first, then **Verify Me** will unlock.*";
        }

        await (channel as TextChannel).send({
          content: `👋 Welcome **${member.user.username}**!\n\n` +
            `Please complete these steps to get full access:${statusNote}`,
          components: [row, row2],
        });
      } catch (err) {
        console.error(`Failed to post verification message for ${member.user.username}:`, err);
      }
    });

    // ── Handle "Verify Me" button click ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("verify_start:")) return;

      const targetUserId = interaction.customId.split(":")[1];

      // Only the mentioned user can click (or admin)
      if (interaction.user.id !== targetUserId) {
        await interaction.reply({ content: "❌ This verification is not for you!", ephemeral: true });
        return;
      }

      const config = getConfig();
      const db = getDb();

      // Check if already verified
      const record = db.prepare("SELECT status, attempts FROM verifications WHERE user_id = ?").get(targetUserId) as any;
      if (record?.status === "verified") {
        await interaction.reply({ content: "✅ You're already verified!", ephemeral: true });
        return;
      }

      // Check max attempts
      if (record?.attempts >= config.quiz.maxAttempts) {
        await interaction.reply({ content: "❌ You've used all attempts. An admin will review your case.", ephemeral: true });
        return;
      }

      // Check if authorized
      if (!hasValidToken(targetUserId)) {
        await interaction.reply({
          content: "🔒 Please click **🔗 Authorize Bot** first! The bot needs your authorization to be able to add you to servers in the future.\n\nAfter authorizing, the Verify Me button will unlock.",
          ephemeral: true,
        });
        return;
      }

      // Check if quiz questions exist
      if (!config.quiz.questions.length) {
        await interaction.reply({ content: "❌ No quiz questions configured. Admin needs to set up the bot first.", ephemeral: true });
        return;
      }

      await interaction.reply({ content: "📝 Starting quiz...", ephemeral: true });
      db.prepare("UPDATE verifications SET agreed_to_rules_at = datetime('now'), quiz_started_at = datetime('now'), status = 'in_progress' WHERE user_id = ?").run(targetUserId);

      this.quizInProgress.set(targetUserId, { questionIndex: 0, answers: {}, channelId: interaction.channelId });

      // Small delay then show first modal
      setTimeout(() => this.sendQuizModal(interaction, 0), 500);
    });

    // ── Handle quiz modal submissions ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("quiz_")) return;

      const parts = interaction.customId.split("_");
      const idx = parseInt(parts[1], 10);
      const userId = parts[2];
      const answer = interaction.fields.getTextInputValue("quiz_answer");

      const state = this.quizInProgress.get(userId);
      if (!state) {
        await interaction.reply({ content: "❌ No active quiz. Click 'Verify Me' to start.", ephemeral: true });
        return;
      }

      state.answers[idx] = answer;

      const config = getConfig();
      const next = idx + 1;

      if (next < config.quiz.questions.length) {
        state.questionIndex = next;
        await interaction.reply({ content: `✅ Answer recorded. Next question...`, ephemeral: true });
        setTimeout(() => this.sendQuizModal(interaction, next), 500);
      } else {
        await interaction.reply({ content: "✅ All answers submitted! Grading...", ephemeral: true });
        setTimeout(() => this.grade(userId, interaction, state.answers, state.channelId), 500);
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

  private async sendQuizModal(interaction: any, idx: number) {
    const config = getConfig();
    const q: QuizQuestion = config.quiz.questions[idx];
    if (!q) return;

    const total = config.quiz.questions.length;
    const optionsText = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("  |  ");

    const modal = new ModalBuilder()
      .setCustomId(`quiz_${idx}_${interaction.user.id}`)
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

  private async grade(userId: string, interaction: any, answers: Record<number, string>, channelId: string) {
    const config = getConfig();
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
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ?").get(userId) as any;
    const newAttempts = (record?.attempts || 0) + 1;

    try {
      if (passed) {
        db.prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now'), attempts = ?, score = ?, answers_json = ? WHERE user_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId);

        const guild = await this.client.guilds.fetch(config.guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(config.roles.verified);
        await member.roles.remove(config.roles.unverified);

        // Post success in verification channel
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          await (channel as any).send(`✅ **${interaction.user.username}** passed the verification quiz! (${correct}/${total} — ${pct}%)`);
        }

        await interaction.followUp({ content: `🎉 **Passed!** ${correct}/${total} (${pct}%). You now have full access!`, ephemeral: true });
      } else {
        db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId);

        if (newAttempts < config.quiz.maxAttempts) {
          const remaining = config.quiz.maxAttempts - newAttempts;
          await interaction.followUp({
            content: `❌ **Failed** — ${correct}/${total} (${pct}%). Need ${config.quiz.passPercentage}%.\n${remaining} attempt${remaining > 1 ? "s" : ""} remaining. Click "Verify Me" to try again.`,
            ephemeral: true,
          });
        } else {
          db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ?").run(userId);
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

    this.quizInProgress.delete(userId);
  }

  // ─── Commands ───

  getStats(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM verifications").get() as any).c;
    const verified = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'verified'").get() as any).c;
    const pending = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'pending' OR status = 'in_progress'").get() as any).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'failed'").get() as any).c;
    const flagged = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'flagged_review'").get() as any).c;
    return `🔐 **Verification:** ${total} total, ${verified} verified, ${pending} pending, ${failed} failed, ${flagged} flagged`;
  }

  async manualVerify(userId: string): Promise<string> {
    const config = getConfig();
    try {
      const guild = await this.client.guilds.fetch(config.guildId);
      const member = await guild.members.fetch(userId);
      await member.roles.add(config.roles.verified);
      await member.roles.remove(config.roles.unverified);
      getDb().prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now') WHERE user_id = ?").run(userId);
      return `✅ <@${userId}> manually verified`;
    } catch {
      return `❌ Could not verify <@${userId}>`;
    }
  }

  getFlagged(): string {
    const users = getDb().prepare("SELECT user_id, attempts, score FROM verifications WHERE status = 'flagged_review'").all() as any[];
    if (!users.length) return "📋 No flagged users";
    return "⚠️ **Flagged for review:**\n" + users.map((u) => `• <@${u.user_id}> — ${u.attempts} attempts, ${u.score}%`).join("\n");
  }
}
