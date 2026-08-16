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
 * Module 3 — Verification + Quiz Gate (Shared Panel, Multi-Server)
 *
 * Flow:
 * 1. Admin posts rules manually in verification channel
 * 2. Admin runs /post-verify → bot posts ONE message with "Verify Me" button
 * 3. When member joins → bot assigns Unverified role + brief welcome
 * 4. User clicks shared "Verify Me" button
 * 5. If no token → gets authorize link
 * 6. Takes quiz → pass → Verified role, fail → retry
 *
 * All logs go to logs channel.
 */
export class VerificationModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  /** Send a log message to the logs channel for this guild */
  private async sendLog(guildId: string, content: string): Promise<void> {
    try {
      const config = getGuildConfig(guildId);
      if (!config.channels.logs) return;
      const channel = await this.client.channels.fetch(config.channels.logs);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      console.error(`[${guildId}] Failed to send log:`, err);
    }
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

      // Log to logs channel
      await this.sendLog(guildId, `👤 **${member.user.username}** (<@${member.user.id}>) joined — assigned Unverified role`);
    });

    // ── Handle "Verify Me" button (shared — anyone can click) ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("verify_start:")) return;

      const guildId = interaction.customId.split(":")[1];
      const userId = interaction.user.id;

      const config = getGuildConfig(guildId);
      const db = getDb();

      const record = db.prepare("SELECT status, attempts FROM verifications WHERE user_id = ? AND guild_id = ?")
        .get(userId, guildId) as any;

      if (record?.status === "verified") {
        await interaction.reply({ content: "✅ You're already verified!", ephemeral: true });
        return;
      }

      if (record?.attempts >= config.quiz.maxAttempts) {
        await interaction.reply({ content: "❌ You've used all attempts. An admin will review your case.", ephemeral: true });
        return;
      }

      // If no token, give them their authorize link
      if (!hasValidToken(userId)) {
        try {
          const authUrl = getOAuth2Url(userId);
          await interaction.reply({
            content: `🔒 You need to authorize the bot first!\n\nClick here: **[🔗 Authorize Bot](${authUrl})**\n\nThen click **✅ Verify Me** again.`,
            ephemeral: true,
          });
        } catch {
          await interaction.reply({
            content: "🔒 You need to authorize the bot first! Ask an admin for help.",
            ephemeral: true,
          });
        }
        return;
      }

      if (!config.quiz.questions.length) {
        await interaction.reply({ content: "❌ No quiz questions configured. Admin needs to add questions with /quiz-add.", ephemeral: true });
        return;
      }

      db.prepare("UPDATE verifications SET agreed_to_rules_at = datetime('now'), quiz_started_at = datetime('now'), status = 'in_progress' WHERE user_id = ? AND guild_id = ?")
        .run(userId, guildId);

      await this.sendQuizModal(interaction, guildId);
    });

    // ── Handle quiz modal submissions ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("quiz_all_")) return;

      const parts = interaction.customId.split("_");
      const userId = parts[2];
      const guildId = parts[3];

      const config = getGuildConfig(guildId);
      const answers: Record<number, string> = {};
      for (const q of config.quiz.questions) {
        answers[q.id - 1] = interaction.fields.getTextInputValue(`q_${q.id}`).trim();
      }
      console.log(`[Quiz] User ${userId} answers:`, JSON.stringify(answers), "Questions:", JSON.stringify(config.quiz.questions.map(q => ({ id: q.id, correct: q.correctAnswer, options: q.options }))));

      await interaction.reply({ content: "✅ All answers submitted! Grading...", ephemeral: true });
      setTimeout(() => this.grade(userId, guildId, interaction, answers), 500);
    });
  }

  private async sendQuizModal(interaction: any, guildId: string) {
    const config = getGuildConfig(guildId);
    const questions = config.quiz.questions.slice(0, 5);

    if (!questions.length) return;

    const actionRows = questions.map((q) => {
      const optionsText = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | ");
      return new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(`q_${q.id}`)
          .setLabel(`Q${q.id}: ${truncate(q.question, 40)}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`A, B, or answer (${optionsText})`)
          .setRequired(true)
          .setMaxLength(100)
      );
    });

    const modal = new ModalBuilder()
      .setCustomId(`quiz_all_${interaction.user.id}_${guildId}`)
      .setTitle(`🔐 Verification Quiz (${questions.length} questions)`)
      .addComponents(...actionRows);

    try {
      await interaction.showModal(modal);
    } catch (err) {
      console.error("Failed to show modal:", err);
    }
  }

  private async grade(userId: string, guildId: string, interaction: any, answers: Record<number, string>) {
    const config = getGuildConfig(guildId);
    const db = getDb();
    let correct = 0;
    const wrongQuestions: string[] = [];

    for (const q of config.quiz.questions) {
      const userAns = (answers[q.id - 1] || "").trim().toLowerCase();
      const correctIdx = q.options.findIndex((o) => o.toLowerCase() === q.correctAnswer.toLowerCase());
      if (
        userAns === q.correctAnswer.toLowerCase() ||
        userAns === String(correctIdx) ||
        userAns === String.fromCharCode(65 + correctIdx).toLowerCase()
      ) {
        correct++;
      } else {
        const correctLetter = String.fromCharCode(65 + correctIdx);
        wrongQuestions.push(
          `❌ **Q${q.id}: ${q.question}**\n` +
          `   Their answer: **${answers[q.id - 1] || "(empty)"}**\n` +
          `   Correct answer: **${correctLetter}. ${q.correctAnswer}**`
        );
      }
    }

    const total = config.quiz.questions.length;
    const pct = Math.round((correct / total) * 100);
    const passed = pct >= config.quiz.passPercentage;
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ? AND guild_id = ?").get(userId, guildId) as any;
    const newAttempts = (record?.attempts || 0) + 1;
    const username = interaction.user?.username || userId;

    try {
      if (passed) {
        db.prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now'), attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId, guildId);

        const guild = await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(config.roles.verified);
        await member.roles.remove(config.roles.unverified);

        await this.sendLog(guildId,
          `✅ **${username}** (<@${userId}>) **PASSED verification!**\n` +
          `📊 Score: **${correct}/${total} (${pct}%)** — Attempt #${newAttempts}\n` +
          `🎖️ Verified role assigned, Unverified role removed`
        );

        await interaction.followUp({ content: `🎉 **Passed!** ${correct}/${total} (${pct}%). You now have full access!`, ephemeral: true });
      } else {
        db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, pct, JSON.stringify(answers), userId, guildId);

        const wrongBlock = wrongQuestions.length > 0
          ? `\n\n**Wrong answers:**\n${wrongQuestions.join("\n\n")}`
          : "";
        const remaining = config.quiz.maxAttempts - newAttempts;

        if (remaining > 0) {
          await this.sendLog(guildId,
            `❌ **${username}** (<@${userId}>) **FAILED verification**\n` +
            `📊 Score: **${correct}/${total} (${pct}%)** — Attempt #${newAttempts}/${config.quiz.maxAttempts}\n` +
            `${remaining} attempt${remaining > 1 ? "s" : ""} remaining` +
            wrongBlock
          );
          await interaction.followUp({
            content: `❌ **Failed** — ${correct}/${total} (${pct}%). Need ${config.quiz.passPercentage}%.\n${remaining} attempt${remaining > 1 ? "s" : ""} remaining.`,
            ephemeral: true,
          });
        } else {
          db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ? AND guild_id = ?").run(userId, guildId);

          await this.sendLog(guildId,
            `⚠️ **${username}** (<@${userId}>) **EXHAUSTED all ${config.quiz.maxAttempts} attempts**\n` +
            `📊 Final score: **${correct}/${total} (${pct}%)**\n` +
            `🚩 Flagged for admin review` +
            wrongBlock
          );
          await interaction.followUp({ content: "❌ Max attempts reached. An admin will review your case.", ephemeral: true });
        }
      }
    } catch (err) {
      console.error("Grade error:", err);
    }
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

      await this.sendLog(guildId,
        `🛡️ **${member.user.username}** (<@${userId}>) manually verified by admin`
      );

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
