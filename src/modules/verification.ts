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
  hasValidToken, storePendingAuthInteraction,
} from "../utils.js";

/**
 * Module 3 — Verification + Quiz Gate (Shared Panel, Multi-Server)
 *
 * Quiz: questions are asked ONE AT A TIME as ephemeral embeds.
 * Each question is shown immediately, then after 5 seconds the answer
 * button(s) appear on the same message:
 *   - Yes/No questions → a Yes / No button pair
 *   - Everything else  → an "Answer" button that opens a modal
 * Once answered it automatically moves on to the next question.
 * All answers must be correct (exact match, case-insensitive).
 *
 * Flow:
 * 1. Admin posts rules, runs /post-verify
 * 2. Member joins → Unverified role assigned + logged (embed)
 * 3. User clicks Verify Me → first question (ephemeral embed)
 * 4. After 5s an answer button appears → user answers
 * 5. Auto-advances to the next question until done
 * 6. Pass (all correct) → Verified role, Fail → retry
 */

interface QuizItem {
  slotId: number;
  question: string;
  options: string[];
  correctAnswer: string;
  isFixed: boolean;
  type?: "yes_no" | "multiple_choice";
}

/** In-memory state for a user's active (in-progress) quiz session. */
interface QuizSession {
  userId: string;
  guildId: string;
  username: string;
  items: QuizItem[];
  currentIndex: number;
  answers: Record<number, string>;
  applicationId: string;
  token: string;
}

const quizSessions = new Map<string, QuizSession>();
const sessionKey = (userId: string, guildId: string) => `${userId}:${guildId}`;

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

      await this.startQuiz(interaction, guildId, userId);
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

    // ── Handle Yes/No answer buttons ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("quiz_yes:") && !interaction.customId.startsWith("quiz_no:")) return;

      const [action, guildId, userId, indexStr] = interaction.customId.split(":");
      const key = sessionKey(interaction.user.id, guildId);
      const session = quizSessions.get(key);

      if (!session || session.currentIndex !== Number(indexStr)) {
        await interaction.reply({
          content: "This quiz question is no longer active. Click **Verify Me** in the verification channel to start a new quiz.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const item = session.items[session.currentIndex];
      session.answers[item.slotId] = action === "quiz_yes" ? "Yes" : "No";

      await interaction.deferUpdate().catch(() => {});
      await this.advance(session);
    });

    // ── Handle "Answer" button (opens modal for free-text / MCQ answers) ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith("quiz_answer:")) return;

      const [, guildId, userId, indexStr] = interaction.customId.split(":");
      const key = sessionKey(interaction.user.id, guildId);
      const session = quizSessions.get(key);

      if (!session || session.currentIndex !== Number(indexStr)) {
        await interaction.reply({
          content: "This quiz question is no longer active. Click **Verify Me** in the verification channel to start a new quiz.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const item = session.items[session.currentIndex];
      const input = new TextInputBuilder()
        .setCustomId("answer")
        .setLabel(item.isFixed ? "Type the exact phrase" : "Your answer (letter, number, or text)")
        .setStyle(item.isFixed ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setPlaceholder(
          item.isFixed
            ? `Type: ${item.correctAnswer}`
            : item.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | ")
        )
        .setRequired(true)
        .setMaxLength(item.isFixed ? 300 : 100);

      const modal = new ModalBuilder()
        .setCustomId(`quiz_modal:${guildId}:${userId}:${indexStr}`)
        .setTitle(`Question ${session.currentIndex + 1}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

      try {
        await interaction.showModal(modal);
      } catch (err) {
        console.error("Failed to show answer modal:", err);
      }
    });

    // ── Handle quiz answer modal submissions ──
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (!interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith("quiz_modal:")) return;

      const [, guildId, userId, indexStr] = interaction.customId.split(":");
      const key = sessionKey(interaction.user.id, guildId);
      const session = quizSessions.get(key);

      if (!session || session.currentIndex !== Number(indexStr)) {
        await interaction.reply({
          content: "This quiz question is no longer active. Click **Verify Me** in the verification channel to start a new quiz.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const item = session.items[session.currentIndex];
      session.answers[item.slotId] = interaction.fields.getTextInputValue("answer").trim();

      await interaction.deferUpdate().catch(() => {});
      await this.advance(session);
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
        type: q.type,
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

  /**
   * Start a new quiz session for a user.
   * Sends the first question as an ephemeral embed, then reveals the
   * answer button(s) on the same message after 5 seconds.
   */
  private async startQuiz(interaction: any, guildId: string, userId: string) {
    const config = getGuildConfig(guildId);
    const items = this.buildQuizItems(config);
    if (!items.length) return;

    const session: QuizSession = {
      userId,
      guildId,
      username: interaction.user?.username || userId,
      items,
      currentIndex: 0,
      answers: {},
      applicationId: interaction.applicationId,
      token: interaction.token,
    };
    const key = sessionKey(userId, guildId);
    quizSessions.set(key, session);

    // Clean up abandoned sessions (ephemeral messages expire after ~15 min)
    setTimeout(() => {
      if (quizSessions.get(key) === session) quizSessions.delete(key);
    }, 15 * 60 * 1000);

    try {
      await interaction.reply({
        embeds: [this.buildQuestionEmbed(session)],
        flags: MessageFlags.Ephemeral,
      });
      setTimeout(() => this.addAnswerButtons(session), 5000);
    } catch (err) {
      console.error("Failed to start quiz:", err);
      quizSessions.delete(key);
    }
  }

  /** Build the ephemeral embed shown for the current question. */
  private buildQuestionEmbed(session: QuizSession): EmbedBuilder {
    const item = session.items[session.currentIndex];
    const embed = new EmbedBuilder()
      .setColor(1564442)
      .setTitle(`❓ Question ${session.currentIndex + 1} of ${session.items.length}`)
      .setDescription(`# ${item.question}`)
      .setThumbnail("https://github.com/RyanYuuki/AnymeX/raw/main/assets/images/logo.png");

    if (item.isFixed) {
      embed.addFields({ name: "How to answer", value: "Click the **Answer** button and type the exact phrase." });
    } else if (item.type === "yes_no") {
      embed.addFields({ name: "How to answer", value: "Use the **Yes / No** buttons below." });
    } else {
      const options = item.options.map((o, i) => `${String.fromCharCode(65 + i)}. **${o}**`).join("\n");
      embed.addFields({ name: "Options", value: options });
      embed.addFields({ name: "How to answer", value: "Click the **Answer** button and type the letter, number, or option text." });
    }

    embed.setFooter({ text: "The answer button will appear in 5 seconds..." });
    return embed;
  }

  /** Add the answer button(s) for the current question (called after 5s). */
  private async addAnswerButtons(session: QuizSession) {
    const key = sessionKey(session.userId, session.guildId);
    if (quizSessions.get(key) !== session) return;

    const item = session.items[session.currentIndex];
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (item.type === "yes_no") {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_yes:${session.guildId}:${session.userId}:${session.currentIndex}`)
          .setLabel("Yes")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`quiz_no:${session.guildId}:${session.userId}:${session.currentIndex}`)
          .setLabel("No")
          .setStyle(ButtonStyle.Danger),
      ));
    } else {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`quiz_answer:${session.guildId}:${session.userId}:${session.currentIndex}`)
          .setLabel("✏️ Answer")
          .setStyle(ButtonStyle.Primary),
      ));
    }

    const ok = await editEphemeralMessage(session.applicationId, session.token, "", components, [this.buildQuestionEmbed(session)]);
    if (!ok) {
      console.warn(`[Quiz] Could not reveal answer buttons for ${session.userId} (message may have expired).`);
      quizSessions.delete(key);
    }
  }

  /** Recorded an answer — move to the next question or finish the quiz. */
  private async advance(session: QuizSession) {
    const key = sessionKey(session.userId, session.guildId);
    if (quizSessions.get(key) !== session) return;

    const next = session.currentIndex + 1;
    if (next < session.items.length) {
      session.currentIndex = next;
      const ok = await editEphemeralMessage(session.applicationId, session.token, "", [], [this.buildQuestionEmbed(session)]);
      if (!ok) {
        console.warn(`[Quiz] Could not advance question for ${session.userId}.`);
        quizSessions.delete(key);
        return;
      }
      setTimeout(() => this.addAnswerButtons(session), 5000);
    } else {
      await this.finishQuiz(session);
    }
  }

  /** All questions answered — grade the quiz, apply roles, update the message. */
  private async finishQuiz(session: QuizSession) {
    const key = sessionKey(session.userId, session.guildId);
    quizSessions.delete(key);

    const { userId, guildId, items, answers, username } = session;
    const config = getGuildConfig(guildId);
    const db = getDb();

    let correct = 0;
    const wrongQuestions: string[] = [];
    const total = items.length;

    for (const item of items) {
      const userAns = (answers[item.slotId] || "").trim().toLowerCase();

      if (item.isFixed && config.quiz.finalQuestion) {
        // Fixed question: exact match (case-insensitive, trimmed)
        const expected = config.quiz.finalQuestion.expectedAnswer.trim().toLowerCase();
        if (userAns === expected) {
          correct++;
        } else {
          wrongQuestions.push(
            `**${config.quiz.finalQuestion.question}**\n` +
            `Their answer: **${answers[item.slotId] || "(empty)"}**\n` +
            `Correct answer: **${config.quiz.finalQuestion.expectedAnswer}**`
          );
        }
      } else {
        // MCQ from pool
        const q = config.quiz.questions.find((qq) => qq.id === item.slotId);
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
            `Their answer: **${answers[item.slotId] || "(empty)"}**\n` +
            `Correct answer: **${correctLetter}. ${q.correctAnswer}**`
          );
        }
      }
    }

    const passed = correct === total; // all must be correct
    const record = db.prepare("SELECT attempts FROM verifications WHERE user_id = ? AND guild_id = ?").get(userId, guildId) as any;
    const newAttempts = (record?.attempts || 0) + 1;

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

        await editEphemeralMessage(session.applicationId, session.token,
          `**Passed!** ${correct}/${total} — All correct! You now have full access.`,
          [], []);
      } else {
        db.prepare("UPDATE verifications SET status = 'failed', attempts = ?, score = ?, answers_json = ? WHERE user_id = ? AND guild_id = ?")
          .run(newAttempts, correct, JSON.stringify(answers), userId, guildId);

        const remaining = config.quiz.maxAttempts - newAttempts;
        const wrongField = wrongQuestions.length > 0 ? wrongQuestions.join("\n\n") : "None";

        if (remaining > 0) {
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
          await editEphemeralMessage(session.applicationId, session.token,
            `**Failed** — ${correct}/${total}. All answers must be correct.\n${remaining} attempt${remaining > 1 ? "s" : ""} remaining.`,
            [], []);
        } else {
          db.prepare("UPDATE verifications SET status = 'flagged_review' WHERE user_id = ? AND guild_id = ?").run(userId, guildId);

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
          await editEphemeralMessage(session.applicationId, session.token,
            "Max attempts reached. An admin will review your case.",
            [], []);
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
