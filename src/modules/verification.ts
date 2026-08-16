import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GuildMember, MessageComponentInteraction, ModalBuilder,
  TextInputBuilder, TextInputStyle,
} from "discord.js";
import { getDb } from "../db.js";
import { getConfig, QuizQuestion } from "../config.js";

/**
 * Module 3 — Verification + Quiz Gate
 * New members get Unverified role → agree to rules → pass quiz → get Verified role.
 */
export class VerificationModule {
  private client: Client;
  private quizInProgress = new Map<string, { questionIndex: number; answers: Record<number, string> }>();

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private setupListeners() {
    this.client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
      const config = getConfig();
      if (!config.roles.unverified || !config.roles.verified) return;

      try { await member.roles.add(config.roles.unverified); } catch {}

      getDb().prepare("INSERT OR IGNORE INTO verifications (user_id, status) VALUES (?, 'pending')").run(member.user.id);

      try {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("verify_agree").setLabel("I Agree to the Rules").setStyle(ButtonStyle.Success).setEmoji("✅")
        );
        await member.send({
          content: `👋 **Welcome, ${member.user.username}!**\n\n---\n${config.termsAndConditions}\n---\n\nClick below to proceed to a quick quiz.`,
          components: [row],
        });
      } catch {
        console.error(`Could not DM ${member.user.username}`);
      }
    });

    // Agree button
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton() || interaction.customId !== "verify_agree") return;
      const config = getConfig();
      await interaction.reply({ content: "✅ Starting quiz...", ephemeral: true });
      getDb().prepare("UPDATE verifications SET agreed_to_rules_at = datetime('now'), quiz_started_at = datetime('now') WHERE user_id = ?").run(interaction.user.id);
      this.quizInProgress.set(interaction.user.id, { questionIndex: 0, answers: {} });
      this.sendQuestion(interaction.user.id, interaction, 0);
    });

    // Quiz modal answers
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isModalSubmit() || !interaction.customId.startsWith("quiz_")) return;
      const idx = parseInt(interaction.customId.split("_")[1], 10);
      const answer = interaction.fields.getTextInputValue("quiz_input");
      const state = this.quizInProgress.get(interaction.user.id);
      if (!state) return;
      state.answers[idx] = answer;

      const config = getConfig();
      const next = idx + 1;
      if (next < config.quiz.questions.length) {
        this.sendQuestion(interaction.user.id, interaction, next);
      } else {
        await this.grade(interaction.user.id, interaction, state.answers);
      }
    });
  }

  private async sendQuestion(userId: string, interaction: any, idx: number) {
    const config = getConfig();
    const q: QuizQuestion = config.quiz.questions[idx];
    const optionsText = q.options.map((o, i) => `**${String.fromCharCode(65 + i)}.** ${o}`).join("\n");

    const modal = new ModalBuilder()
      .setCustomId(`quiz_${idx}`)
      .setTitle(`Q${idx + 1}/${config.quiz.questions.length}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("quiz_input").setLabel(q.question).setStyle(TextInputStyle.Short).setPlaceholder("Your answer...").setRequired(true)
        )
      );

    await interaction.followUp({ content: `📝 **Q${idx + 1}:** ${q.question}\n${optionsText}`, ephemeral: true });
    await interaction.showModal(modal);
  }

  private async grade(userId: string, interaction: any, answers: Record<number, string>) {
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
      ) correct++;
    }

    const pct = Math.round((correct / config.quiz.questions.length) * 100);
    const passed = pct >= config.quiz.passPercentage;
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ?").get(userId) as any;
    const newAttempts = (record?.attempts || 0) + 1;

    if (passed) {
      db.prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now'), attempts = ?, score = ?, answers_json = ? WHERE user_id = ?")
        .run(newAttempts, pct, JSON.stringify(answers), userId);
      try {
        const guild = await this.client.guilds.fetch(config.guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(config.roles.verified);
        await member.roles.remove(config.roles.unverified);
      } catch {}
      await interaction.followUp({ content: `🎉 **Passed!** ${correct}/${config.quiz.questions.length} (${pct}%). You now have full access!`, ephemeral: true });
    } else {
      db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ?")
        .run(newAttempts, pct, JSON.stringify(answers), userId);
      if (newAttempts < config.quiz.maxAttempts) {
        await interaction.followUp({ content: `❌ **Failed** — ${correct}/${config.quiz.questions.length} (${pct}%). Need ${config.quiz.passPercentage}%. ${config.quiz.maxAttempts - newAttempts} tries left.`, ephemeral: true });
      } else {
        db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ?").run(userId);
        await interaction.followUp({ content: `❌ Max attempts reached. An admin will review your case.`, ephemeral: true });
      }
    }
    this.quizInProgress.delete(userId);
  }

  // ─── Commands ───

  getStats(): string {
    const db = getDb();
    const total = (db.prepare("SELECT COUNT(*) as c FROM verifications").get() as any).c;
    const verified = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'verified'").get() as any).c;
    const pending = (db.prepare("SELECT COUNT(*) as c FROM verifications WHERE status = 'pending'").get() as any).c;
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
    return "⚠️ **Flagged:**\n" + users.map((u) => `• <@${u.user_id}> — ${u.attempts} attempts, ${u.score}%`).join("\n");
  }
}
