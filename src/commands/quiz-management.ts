// @ts-nocheck — discord.js type quirks with bun
import {
  Client, CommandInteraction, Interaction, MessageFlags, ModalBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, PermissionFlagsBits,
} from "discord.js";
import { getGuildConfig, saveGuildConfig, QuizQuestion, FinalQuestion } from "../config.js";
import { getOAuth2Url } from "../utils.js";

// ─── /post-verify ───
export function getPostVerifyCommand() {
  return new SlashCommandBuilder()
    .setName("post-verify")
    .setDescription("Post verification button in verification channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handlePostVerifyCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  if (!config.channels.verification) {
    await interaction.reply({ content: "❌ No verification channel set. Run /setup first.", flags: MessageFlags.Ephemeral });
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setURL(getOAuth2Url())
      .setLabel("🔗 Authorize Bot")
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setCustomId(`verify_start:${guildId}`)
      .setLabel("✅ Verify Me")
      .setStyle(ButtonStyle.Success)
  );

  try {
    const channel = await client.channels.fetch(config.channels.verification);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: "❌ Verification channel not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    await (channel as any).send({
      embeds: [
        new EmbedBuilder()
          .setColor(1564442)
          .setDescription("#  User Verification\n## New here? Read the rules above, then follow these steps:\n### 1️⃣ Click 🔗 Authorize Bot to link your account\n### 2️⃣ Click ✅ Verify Me to take a quick quiz\n### 3️⃣ Pass and you're in!")
          .setThumbnail("https://github.com/RyanYuuki/AnymeX/raw/main/assets/images/logo.png")
          .setFooter({
            text: "Due to Discord constantly taking AnymeX down, the bot will use the “Join Servers for You” permission to automatically have you rejoin the new server if this one gets taken down.\n",
          })
          .setFields(
          ),
      ],
      components: [row],
    });

    await interaction.reply({ content: `✅ Verification button posted in <#${config.channels.verification}>`, flags: MessageFlags.Ephemeral });
  } catch (err: any) {
    await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral });
  }
}

// ─── /set-final-question ───
export function getSetFinalQuestionCommand() {
  return new SlashCommandBuilder()
    .setName("set-final-question")
    .setDescription("Set the fixed acknowledgment question (shown to all users)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handleSetFinalQuestionCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  const modal = new ModalBuilder()
    .setCustomId(`set_final_q:${guildId}`)
    .setTitle("📝 Set Fixed Question");

  const questionInput = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("question")
      .setLabel("Question Text")
      .setStyle(TextInputStyle.Paragraph)
      .setValue(config.quiz.finalQuestion?.question || "")
      .setPlaceholder("e.g. No sharing of 3rd-party repos. Type: I will not share...")
      .setRequired(true)
      .setMaxLength(500)
  );

  const answerInput = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("answer")
      .setLabel("Expected Answer (exact match)")
      .setStyle(TextInputStyle.Paragraph)
      .setValue(config.quiz.finalQuestion?.expectedAnswer || "")
      .setPlaceholder("e.g. I will not share any third-party repos or APKs")
      .setRequired(true)
      .setMaxLength(500)
  );

  modal.addComponents(questionInput, answerInput);
  await interaction.showModal(modal);
}

// ─── /quiz-add ───
export function getQuizAddCommand() {
  return new SlashCommandBuilder()
    .setName("quiz-add")
    .setDescription("Add a quiz question to the pool")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handleQuizAddCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  const modal = new ModalBuilder()
    .setCustomId(`quiz_add:${guildId}`)
    .setTitle(`➕ Add Quiz Question (Pool: ${config.quiz.questions.length})`);

  const questionInput = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("question")
      .setLabel("Question")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("e.g. Is spam allowed?")
      .setRequired(true)
      .setMaxLength(300)
  );

  const optionA = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("option_a")
      .setLabel("Option A")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. Yes")
      .setRequired(true)
      .setMaxLength(100)
  );

  const optionB = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("option_b")
      .setLabel("Option B")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. No")
      .setRequired(true)
      .setMaxLength(100)
  );

  const correctInput = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("correct_answer")
      .setLabel("Correct Answer")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. No")
      .setRequired(true)
      .setMaxLength(100)
  );

  modal.addComponents(questionInput, optionA, optionB, correctInput);
  await interaction.showModal(modal);
}

// ─── /quiz-list ───
export function getQuizListCommand() {
  return new SlashCommandBuilder()
    .setName("quiz-list")
    .setDescription("View all quiz questions and fixed question")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handleQuizListCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  let content = "";

  // MCQ pool
  if (config.quiz.questions.length) {
    const list = config.quiz.questions.map((q) => {
      const options = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${o === q.correctAnswer ? " ✅" : ""}`).join(" | ");
      return `**Q${q.id}:** ${q.question}\n   ${options}`;
    }).join("\n\n");
    content += `📋 **Question Pool (${config.quiz.questions.length}):**\nQuiz picks 4 random per attempt.\n\n${list}`;
  } else {
    content += `📋 **Question Pool:** Empty — use /quiz-add`;
  }

  // Fixed question
  if (config.quiz.finalQuestion) {
    content += `\n\n---\n\n📌 **Fixed Question (always shown):**\n**Q:** ${config.quiz.finalQuestion.question}\n**Answer:** \`${config.quiz.finalQuestion.expectedAnswer}\``;
  } else {
    content += `\n\n---\n\n📌 **Fixed Question:** Not set — use /set-final-question`;
  }

  content += `\n\n⚙️ Max attempts: ${config.quiz.maxAttempts} | All answers must be correct`;

  await interaction.editReply({ content });
}

// ─── /quiz-remove ───
export function getQuizRemoveCommand() {
  return new SlashCommandBuilder()
    .setName("quiz-remove")
    .setDescription("Remove a quiz question from the pool by number")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((o) => o.setName("number").setDescription("Question number to remove").setRequired(true).setMinValue(1).setMaxValue(99));
}

export async function handleQuizRemoveCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);
  const num = interaction.options.getInteger("number", true);

  const idx = config.quiz.questions.findIndex((q) => q.id === num);
  if (idx === -1) {
    await interaction.editReply({ content: `❌ No question #${num} found. Use /quiz-list to see all.` });
    return;
  }

  const removed = config.quiz.questions.splice(idx, 1);
  config.quiz.questions.forEach((q, i) => { q.id = i + 1; });

  saveGuildConfig(guildId, { quiz: { ...config.quiz, questions: config.quiz.questions } });

  await interaction.editReply({ content: `🗑️ Removed: **Q${removed[0].id}: ${removed[0].question}**\n${config.quiz.questions.length} question(s) remaining in pool.` });
}

// ─── Handle modal submissions ───
export async function handleManagementModal(interaction: Interaction, client: Client): Promise<boolean> {
  if (!interaction.isModalSubmit()) return false;

  const customId = interaction.customId;

  // ── Set Final Question modal ──
  if (customId.startsWith("set_final_q:")) {
    const guildId = customId.split(":")[1];
    const question = interaction.fields.getTextInputValue("question").trim();
    const answer = interaction.fields.getTextInputValue("answer").trim();

    if (!question || !answer) {
      await interaction.reply({ content: "❌ Both fields are required.", flags: MessageFlags.Ephemeral });
      return true;
    }

    saveGuildConfig(guildId, {
      quiz: {
        ...getGuildConfig(guildId).quiz,
        finalQuestion: { question, expectedAnswer: answer },
      },
    });

    await interaction.reply({
      content: `✅ **Fixed question updated!**\n\n**Q:** ${question}\n**Answer:** \`${answer}\``,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // ── Quiz Add modal ──
  if (customId.startsWith("quiz_add:")) {
    const guildId = customId.split(":")[1];
    const question = interaction.fields.getTextInputValue("question").trim();
    const optionA = interaction.fields.getTextInputValue("option_a").trim();
    const optionB = interaction.fields.getTextInputValue("option_b").trim();
    const correctAnswer = interaction.fields.getTextInputValue("correct_answer").trim();

    if (!question || !optionA || !optionB || !correctAnswer) {
      await interaction.reply({ content: "❌ All fields are required.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const config = getGuildConfig(guildId);
    const newQuestion: QuizQuestion = {
      id: config.quiz.questions.length + 1,
      question,
      type: optionA === "Yes" && optionB === "No" ? "yes_no" : "multiple_choice",
      options: [optionA, optionB],
      correctAnswer,
    };

    config.quiz.questions.push(newQuestion);
    config.quiz.questions.forEach((q, i) => { q.id = i + 1; });

    saveGuildConfig(guildId, { quiz: { ...config.quiz, questions: config.quiz.questions } });

    const options = newQuestion.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${o === correctAnswer ? " ✅" : ""}`).join(" | ");
    await interaction.reply({
      content: `✅ **Question added!** (Pool: ${config.quiz.questions.length})\n\n**Q${newQuestion.id}:** ${newQuestion.question}\n   ${options}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}
