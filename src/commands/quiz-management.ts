// @ts-nocheck — discord.js type quirks with bun
import {
  Client, CommandInteraction, Interaction, ModalBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, PermissionFlagsBits,
} from "discord.js";
import { getGuildConfig, saveGuildConfig, QuizQuestion } from "../config.js";
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
    await interaction.reply({ content: "❌ No verification channel set. Run /setup first.", ephemeral: true });
    return;
  }

  const { ActionRowBuilder: Arb, ButtonBuilder, ButtonStyle } = await import("discord.js");

  const row = new Arb<ButtonBuilder>().addComponents(
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
      await interaction.reply({ content: "❌ Verification channel not found.", ephemeral: true });
      return;
    }

    await (channel as any).send({
      content: "Click **✅ Verify Me** below to start verification and get full access.",
      components: [row],
    });

    await interaction.reply({ content: `✅ Verification button posted in <#${config.channels.verification}>`, ephemeral: true });
  } catch (err: any) {
    await interaction.reply({ content: `❌ Failed: ${err.message}`, ephemeral: true });
  }
}

// ─── /quiz-add ───
export function getQuizAddCommand() {
  return new SlashCommandBuilder()
    .setName("quiz-add")
    .setDescription("Add a quiz question (max 5 total)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handleQuizAddCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  if (config.quiz.questions.length >= 5) {
    await interaction.reply({ content: "❌ Max 5 questions allowed (Discord modal limit). Use /quiz-remove to remove one first.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`quiz_add:${guildId}`)
    .setTitle(`➕ Add Quiz Question (${config.quiz.questions.length}/5)`);

  const questionInput = new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("question")
      .setLabel("Question")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("e.g. Is spam allowed in this server?")
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
    .setDescription("View all quiz questions")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export async function handleQuizListCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);

  if (!config.quiz.questions.length) {
    await interaction.editReply({ content: "📋 No quiz questions configured.\nUse **/quiz-add** to add questions." });
    return;
  }

  const list = config.quiz.questions.map((q) => {
    const options = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${o === q.correctAnswer ? " ✅" : ""}`).join(" | ");
    return `**Q${q.id}:** ${q.question}\n   ${options}`;
  }).join("\n\n");

  await interaction.editReply({
    content: `📋 **Quiz Questions (${config.quiz.questions.length}/5):**\nPass: ${config.quiz.passPercentage}% | Max attempts: ${config.quiz.maxAttempts}\n\n${list}`,
  });
}

// ─── /quiz-remove ───
export function getQuizRemoveCommand() {
  return new SlashCommandBuilder()
    .setName("quiz-remove")
    .setDescription("Remove a quiz question by number")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption((o) => o.setName("number").setDescription("Question number to remove (e.g. 1, 2, 3)").setRequired(true).setMinValue(1).setMaxValue(5));
}

export async function handleQuizRemoveCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guildId = interaction.guild?.id || "";
  const config = getGuildConfig(guildId);
  const num = interaction.options.getInteger("number", true);

  const idx = config.quiz.questions.findIndex((q) => q.id === num);
  if (idx === -1) {
    await interaction.editReply({ content: `❌ No question #${num} found.` });
    return;
  }

  const removed = config.quiz.questions.splice(idx, 1);
  config.quiz.questions.forEach((q, i) => { q.id = i + 1; });

  saveGuildConfig(guildId, { quiz: { ...config.quiz, questions: config.quiz.questions } });

  await interaction.editReply({ content: `🗑️ Removed: **Q${removed[0].id}: ${removed[0].question}**\n${config.quiz.questions.length} question(s) remaining.` });
}

// ─── Handle modal submissions ───
export async function handleManagementModal(interaction: Interaction, client: Client): Promise<boolean> {
  if (!interaction.isModalSubmit()) return false;

  const customId = interaction.customId;

  // ── Quiz Add modal ──
  if (customId.startsWith("quiz_add:")) {
    const guildId = customId.split(":")[1];
    const question = interaction.fields.getTextInputValue("question").trim();
    const optionA = interaction.fields.getTextInputValue("option_a").trim();
    const optionB = interaction.fields.getTextInputValue("option_b").trim();
    const correctAnswer = interaction.fields.getTextInputValue("correct_answer").trim();

    if (!question || !optionA || !optionB || !correctAnswer) {
      await interaction.reply({ content: "❌ All fields are required.", ephemeral: true });
      return true;
    }

    const config = getGuildConfig(guildId);
    if (config.quiz.questions.length >= 5) {
      await interaction.reply({ content: "❌ Max 5 questions. Use /quiz-remove first.", ephemeral: true });
      return true;
    }

    const newQuestion: QuizQuestion = {
      id: config.quiz.questions.length + 1,
      question,
      type: "yes_no",
      options: [optionA, optionB],
      correctAnswer,
    };

    config.quiz.questions.push(newQuestion);
    config.quiz.questions.forEach((q, i) => { q.id = i + 1; });

    saveGuildConfig(guildId, { quiz: { ...config.quiz, questions: config.quiz.questions } });

    const options = newQuestion.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}${o === correctAnswer ? " ✅" : ""}`).join(" | ");
    await interaction.reply({
      content: `✅ **Question added!** (${config.quiz.questions.length}/5)\n\n**Q${newQuestion.id}:** ${newQuestion.question}\n   ${options}\n\nUse **/quiz-list** to see all questions.`,
      ephemeral: true,
    });
    return true;
  }

  return false;
}
