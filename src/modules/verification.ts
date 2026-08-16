// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Colors, EmbedBuilder, Events,
  GuildMember, Interaction, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, TextChannel,
} from "discord.js";
import { getDb } from "../db.js";
import { getGuildConfig, GuildConfig, QuizQuestion, FinalQuestion } from "../config.js";
import {
  clearPendingAuthInteraction, editEphemeralMessage, getOAuth2Url, getPendingAuthInteraction,
  hasValidToken, storePendingAuthInteraction, truncate,
} from "../utils.js";

/**
 * Module 3 — Verification + Quiz Gate (Shared Panel, Multi-Server)
 *
 * Quiz: 4 random MCQs from pool + 1 fixed question, shuffled, all 5 in modal.
 * All answers must be correct (exact match, case-insensitive).
 *
 * Flow:
 * 1. Admin posts rules, runs /post-verify
 * 2. Member joins → Unverified role assigned + logged (embed)
 * 3. User clicks Verify Me → quiz modal (5 questions)
 * 4. Pass (5/5) → Verified role, Fail → retry
 */

interface QuizItem {
  slotId: number;
  question: string;
  options: string[];
  correctAnswer: string;
  isFixed: boolean;
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Shared embed styling used across all verification prompts (public + ephemeral). */
export function buildVerificationEmbed(description: string, includeFooter: boolean = true): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(1564442)
    .setDescription(description)
    .setThumbnail("https://github.com/RyanYuuki/AnymeX/raw/main/assets/images/logo.png");
  if (includeFooter) {
    embed.setFooter({
      text: "Due to Discord constantly taking AnymeX down, the bot will use the “Join Servers for You” permission to automatically have you rejoin the new server if this one gets taken down.\n",
    });
  }
  return embed;
}

export class VerificationModule {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
    this.setupListeners();
  }

  private async sendLog(guildId: string, embed: EmbedBuilder): Promise<void> {
    try {
      const config = getGuildConfig(guildId);
      if (!config.channels.logs) return;
      const channel = await this.client.channels.fetch(config.channels.logs);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err) {
      console.error(`[${guildId}] Failed to send log:`, err);
    }
  }

  private setupListeners() {
    // ── On member join (or rejoin) ──
    this.client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
      const guildId = member.guild.id;
      const config = getGuildConfig(guildId);

      if (!config.isSetup || !config.roles.unverified || !config.roles.verified || !config.channels.verification) return;

      const wasReturning = getDb().prepare("SELECT status FROM verifications WHERE user_id = ? AND guild_id = ?")
        .get(member.user.id, guildId) as any;

      try {
        // Remove verified role if they had it (returning user)
        if (member.roles.cache.has(config.roles.verified)) {
          await member.roles.remove(config.roles.verified);
        }
        await member.roles.add(config.roles.unverified);
      } catch (err) {
        console.error(`[${guildId}] Failed to assign roles to ${member.user.username}:`, err);
        return;
      }

      // Reset verification record — user must re-verify every time they join
      getDb().prepare(`
        INSERT INTO verifications (user_id, guild_id, status, attempts, score, answers_json, agreed_to_rules_at, quiz_started_at, quiz_passed_at)
        VALUES (?, ?, 'pending', 0, 0, '[]', NULL, NULL, NULL)
        ON CONFLICT(user_id, guild_id) DO UPDATE SET
          status = 'pending',
          attempts = 0,
          score = 0,
          answers_json = '[]',
          agreed_to_rules_at = NULL,
          quiz_started_at = NULL,
          quiz_passed_at = NULL
      `).run(member.user.id, guildId);

      if (wasReturning) {
        await this.sendLog(guildId,
          new EmbedBuilder()
            .setColor(Colors.Fuchsia)
            .setTitle("Member Rejoined")
            .setDescription(`**${member.user.username}** (<@${member.user.id}>)`)
            .addFields(
              { name: "Action", value: "Verification reset to Unverified", inline: true },
              { name: "Roles", value: `Removed <@&${config.roles.verified}>, Added <@&${config.roles.unverified}>`, inline: true },
            )
            .setTimestamp()
        );
      } else {
        await this.sendLog(guildId,
          new EmbedBuilder()
            .setColor(Colors.Blurple)
            .setTitle("Member Joined")
            .setDescription(`**${member.user.username}** (<@${member.user.id}>)`)
            .addFields(
              { name: "Role Assigned", value: `<@&${config.roles.unverified}>`, inline: true },
              { name: "Status", value: "Awaiting verification", inline: true },
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
            .setTimestamp()
        );
      }
    });

    // ── On member leave ──
    this.client.on(Events.GuildMemberRemove, async (member: GuildMember) => {
      const guildId = member.guild.id;
      const config = getGuildConfig(guildId);
      if (!config.isSetup) return;

      await this.sendLog(guildId,
        new EmbedBuilder()
          .setColor(Colors.DarkGrey)
          .setTitle("Member Left")
          .setDescription(`**${member.user.username}** (<@${member.user.id}>)`)
          .setTimestamp()
      );
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
        await interaction.reply({ content: "You're already verified!", flags: MessageFlags.Ephemeral });
        return;
      }

      if (record?.attempts >= config.quiz.maxAttempts) {
        await interaction.reply({ content: "You've used all attempts. An admin will review your case.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (!hasValidToken(userId)) {
        try {
          const authUrl = getOAuth2Url(userId, guildId);
          storePendingAuthInteraction(userId, interaction.applicationId, interaction.token, guildId);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setURL(authUrl).setLabel("🔗 Authorize Bot").setStyle(ButtonStyle.Link)
          );

          await interaction.reply({
            embeds: [buildVerificationEmbed(
              "#  You Need to Authorize First\n### 1️⃣ Click the **Authorize Bot** button below to link your Discord account\n### 2️⃣ After you authorize, the **Verify Me** button will appear right here\n### 3️⃣ Click it to take a quick quiz"
            )],
            components: [row],
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          await interaction.reply({
            content: "You need to authorize the bot first! Ask an admin for help.",
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (!config.quiz.questions.length && !config.quiz.finalQuestion) {
        await interaction.reply({ content: "No quiz configured. Admin needs to add questions with /quiz-add.", flags: MessageFlags.Ephemeral });
        return;
      }

      db.prepare("UPDATE verifications SET agreed_to_rules_at = datetime('now'), quiz_started_at = datetime('now'), status = 'in_progress' WHERE user_id = ? AND guild_id = ?")
        .run(userId, guildId);

      await this.sendQuizModal(interaction, guildId);
    });

    // ── Handle "Authorize Bot" button (captures interaction for post-auth prompt) ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("auth_start:")) return;

      const guildId = interaction.customId.split(":")[1];
      const userId = interaction.user.id;

      try {
        const authUrl = getOAuth2Url(userId, guildId);
        storePendingAuthInteraction(userId, interaction.applicationId, interaction.token, guildId);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setURL(authUrl).setLabel("🔗 Click here to Authorize").setStyle(ButtonStyle.Link)
        );

        await interaction.reply({
          embeds: [buildVerificationEmbed(
            "#  Authorize Your Account\n### 1️⃣ Click the **Authorize** button below to link your Discord account\n### 2️⃣ After you authorize, a **Verify Me** button will appear right here\n### 3️⃣ Click it to take a quick quiz"
          )],
          components: [row],
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error(`[${guildId}] Failed to start authorization for ${userId}:`, err);
        await interaction.reply({
          content: "Something went wrong starting authorization. Ask an admin for help.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    });

    // ── Handle quiz modal submissions ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("quiz_all_")) return;

      const parts = interaction.customId.split("_");
      const userId = parts[2];
      const guildId = parts[3];
      // parts[4] contains comma-separated slotIds that were in the modal
      const slotIds = parts[4] ? parts[4].split(",").map(Number) : [];

      const answers: Record<number, string> = {};
      for (const slotId of slotIds) {
        const fieldId = slotId === 100 ? "q_fixed" : `q_${slotId}`;
        answers[slotId] = interaction.fields.getTextInputValue(fieldId).trim();
      }

      console.log(`[Quiz] User ${userId} answers:`, JSON.stringify(answers));

      await interaction.reply({ content: "All answers submitted! Grading...", flags: MessageFlags.Ephemeral });
      setTimeout(() => this.grade(userId, guildId, interaction, answers), 500);
    });
  }

  /** Build quiz items: 4 random MCQs + 1 fixed, shuffled */
  private buildQuizItems(config: GuildConfig): QuizItem[] {
    const items: QuizItem[] = [];

    // Pick 4 random MCQs (or fewer if pool is small)
    const pool = config.quiz.questions.length > 4
      ? shuffleArray(config.quiz.questions).slice(0, 4)
      : shuffleArray(config.quiz.questions);

    pool.forEach((q) => {
      items.push({
        slotId: q.id,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        isFixed: false,
      });
    });

    // Add fixed question
    if (config.quiz.finalQuestion) {
      items.push({
        slotId: 100,
        question: config.quiz.finalQuestion.question,
        options: [],
        correctAnswer: config.quiz.finalQuestion.expectedAnswer,
        isFixed: true,
      });
    }

    return shuffleArray(items);
  }

  private async sendQuizModal(interaction: any, guildId: string) {
    const config = getGuildConfig(guildId);
    const items = this.buildQuizItems(config);

    if (!items.length) return;

    const actionRows = items.map((item) => {
      const label = item.isFixed ? "Fixed Question — type exactly" : `Q: ${truncate(item.question, 35)}`;
      const placeholder = item.isFixed
        ? `Type: ${item.correctAnswer}`
        : item.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | ");

      return new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(item.isFixed ? "q_fixed" : `q_${item.slotId}`)
          .setLabel(label)
          .setStyle(item.isFixed ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setRequired(true)
          .setMaxLength(item.isFixed ? 300 : 100)
      );
    });

    // Encode selected slotIds in modal customId so grading knows exactly which questions to check
    const slotIdsStr = items.map((item) => item.slotId).join(",");
    const modal = new ModalBuilder()
      .setCustomId(`quiz_all_${interaction.user.id}_${guildId}_${slotIdsStr}`)
      .setTitle(`Verification Quiz (${items.length} questions)`)
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
    const total = Object.keys(answers).length;

    // Check only the questions that were in the modal (by slotId from answers keys)
    for (const slotIdStr of Object.keys(answers)) {
      const slotId = Number(slotIdStr);
      const userAns = (answers[slotId] || "").trim().toLowerCase();

      if (slotId === 100 && config.quiz.finalQuestion) {
        // Fixed question: exact match (case-insensitive, trimmed)
        const expected = config.quiz.finalQuestion.expectedAnswer.trim().toLowerCase();
        if (userAns === expected) {
          correct++;
        } else {
          wrongQuestions.push(
            `**${config.quiz.finalQuestion.question}**\n` +
            `Their answer: **${answers[slotId] || "(empty)"}**\n` +
            `Correct answer: **${config.quiz.finalQuestion.expectedAnswer}**`
          );
        }
      } else {
        // MCQ from pool
        const q = config.quiz.questions.find((q) => q.id === slotId);
        if (!q) continue;
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
            `**${q.question}**\n` +
            `Their answer: **${answers[slotId] || "(empty)"}**\n` +
            `Correct answer: **${correctLetter}. ${q.correctAnswer}**`
          );
        }
      }
    }

    const passed = correct === total; // all must be correct
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ? AND guild_id = ?").get(userId, guildId) as any;
    const newAttempts = (record?.attempts || 0) + 1;
    const username = interaction.user?.username || userId;

    try {
      if (passed) {
        db.prepare("UPDATE verifications SET status = 'verified', quiz_passed_at = datetime('now'), attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, correct, JSON.stringify(answers), userId, guildId);

        const guild = await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.add(config.roles.verified);
        await member.roles.remove(config.roles.unverified);

        await this.sendLog(guildId,
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("Verification Passed")
            .setDescription(`**${username}** (<@${userId}>) passed the quiz`)
            .addFields(
              { name: "Score", value: `${correct}/${total} — All correct`, inline: true },
              { name: "Attempt", value: `#${newAttempts}`, inline: true },
              { name: "Roles", value: `Added <@&${config.roles.verified}>, Removed <@&${config.roles.unverified}>`, inline: false },
            )
            .setTimestamp()
        );

        await interaction.followUp({ content: `**Passed!** ${correct}/${total} — All correct! You now have full access.`, flags: MessageFlags.Ephemeral });
      } else {
        db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, correct, JSON.stringify(answers), userId, guildId);

        const remaining = config.quiz.maxAttempts - newAttempts;

        if (remaining > 0) {
          const wrongField = wrongQuestions.length > 0 ? wrongQuestions.join("\n\n") : "None";
          await this.sendLog(guildId,
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle("Verification Failed")
              .setDescription(`**${username}** (<@${userId}>) failed the quiz`)
              .addFields(
                { name: "Score", value: `${correct}/${total} — All must be correct`, inline: true },
                { name: "Attempt", value: `#${newAttempts}/${config.quiz.maxAttempts}`, inline: true },
                { name: "Remaining", value: `${remaining} attempt${remaining > 1 ? "s" : ""}`, inline: true },
              )
              .addFields({ name: "Wrong Answers", value: wrongField })
              .setTimestamp()
          );
          await interaction.followUp({
            content: `**Failed** — ${correct}/${total}. All answers must be correct.\n${remaining} attempt${remaining > 1 ? "s" : ""} remaining.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ? AND guild_id = ?").run(userId, guildId);

          const wrongField = wrongQuestions.length > 0 ? wrongQuestions.join("\n\n") : "None";
          await this.sendLog(guildId,
            new EmbedBuilder()
              .setColor(Colors.Orange)
              .setTitle("Max Attempts Exhausted")
              .setDescription(`**${username}** (<@${userId}>) used all ${config.quiz.maxAttempts} attempts`)
              .addFields(
                { name: "Final Score", value: `${correct}/${total}`, inline: true },
                { name: "Status", value: "Flagged for admin review", inline: true },
              )
              .addFields({ name: "Wrong Answers", value: wrongField })
              .setTimestamp()
          );
          await interaction.followUp({ content: "Max attempts reached. An admin will review your case.", flags: MessageFlags.Ephemeral });
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
    return `**Verification:** ${total} total | ${verified} verified | ${pending} pending | ${failed} failed | ${flagged} flagged`;
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
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("Manual Verification")
          .setDescription(`**${member.user.username}** (<@${userId}>) was manually verified by an admin`)
          .setTimestamp()
      );

      return `<@${userId}> manually verified`;
    } catch {
      return `Could not verify <@${userId}>`;
    }
  }

  getFlagged(guildId: string): string {
    const users = getDb().prepare("SELECT user_id, attempts, score FROM verifications WHERE guild_id = ? AND status = 'flagged_review'").all(guildId) as any[];
    if (!users.length) return "No flagged users";
    return "**Flagged for review:**\n" + users.map((u) => `<@${u.user_id}> — ${u.attempts} attempts, ${u.score}/${5}`).join("\n");
  }
}

/**
 * Called by the OAuth2 callback after a user authorizes.
 * Updates the user's pending ephemeral message (from the Authorize button)
 * to show the Verify Me button now that they have a valid token.
 */
export async function notifyAuthorized(userId: string): Promise<void> {
  const pending = getPendingAuthInteraction(userId);
  if (!pending) return;

  clearPendingAuthInteraction(userId);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify_start:${pending.guild_id}`)
      .setLabel("✅ Verify Me")
      .setStyle(ButtonStyle.Success)
  );

  const ok = await editEphemeralMessage(
    pending.application_id,
    pending.interaction_token,
    "",
    [row],
    [buildVerificationEmbed(
      "#  Authorization Complete ✅\n### Click **Verify Me** below to take the quiz and get full access"
    )],
  );

  if (!ok) {
    console.warn(`[Verification] Could not update auth prompt for ${userId} (interaction may have expired).`);
  }
}
