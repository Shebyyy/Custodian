// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Client, CommandInteraction, Interaction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { getGuildConfig, saveGuildConfig, getGlobalConfig } from "../config.js";

/**
 * /setup — One-shot per-guild setup via modal form(s).
 * Each server has its own config stored in DB.
 *
 * Modal 1: Roles + Welcome/Rules channels (5 fields)
 * Modal 2: Verification channel + quiz settings (5 fields)
 */

export function getSetupCommands() {
  return [
    { name: "setup" as const, description: "Configure Custodian for this server (admin only)" },
  ];
}

export async function handleSetupCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  // Find the guild
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "❌ Run this command in a server.", ephemeral: true });
    return;
  }

  const existingConfig = getGuildConfig(guild.id);

  // Show first modal: Roles + Channels (5 fields)
  const modal = new ModalBuilder()
    .setCustomId(`setup_modal_1:${guild.id}`)
    .setTitle("⚙️ Custodian Setup — Roles & Channels")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_unverified")
          .setLabel("Unverified Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.roles.unverified || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_verified")
          .setLabel("Verified Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.roles.verified || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_admin")
          .setLabel("Admin Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.roles.admin || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channel_welcome")
          .setLabel("Welcome Channel ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.channels.welcome || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channel_rules")
          .setLabel("Rules Channel ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.channels.rules || "")
      ),
    );

  await interaction.showModal(modal);
}

export async function handleSetupInteraction(interaction: Interaction, client: Client): Promise<boolean> {
  if (!interaction.isModalSubmit()) return false;

  if (interaction.customId.startsWith("setup_modal_1:")) {
    return await handleModal1(interaction, client) || true;
  }

  if (interaction.customId.startsWith("setup_modal_2:")) {
    return await handleModal2(interaction) || true;
  }

  return false;
}

async function handleModal1(interaction: any, client: Client): Promise<boolean> {
  const guildId = interaction.customId.split(":")[1];
  const roleUnverified = interaction.fields.getTextInputValue("role_unverified").trim();
  const roleVerified = interaction.fields.getTextInputValue("role_verified").trim();
  const roleAdmin = interaction.fields.getTextInputValue("role_admin").trim();
  const channelWelcome = interaction.fields.getTextInputValue("channel_welcome").trim();
  const channelRules = interaction.fields.getTextInputValue("channel_rules").trim();

  const idRegex = /^\d{17,20}$/;
  for (const [name, val] of [
    ["Unverified Role", roleUnverified], ["Verified Role", roleVerified],
    ["Admin Role", roleAdmin], ["Welcome Channel", channelWelcome], ["Rules Channel", channelRules],
  ]) {
    if (!idRegex.test(val)) {
      await interaction.reply({
        content: `❌ "${name}" is not a valid Discord ID (should be 17-20 digits). Run /setup again.`,
        ephemeral: true,
      });
      return true;
    }
  }

  // Store temp data
  const key = `${interaction.user.id}:${guildId}`;
  if (!(globalThis as any).__setupTemp) (globalThis as any).__setupTemp = new Map();
  (globalThis as any).__setupTemp.set(key, {
    roles: { unverified: roleUnverified, verified: roleVerified, admin: roleAdmin },
    channels: { welcome: channelWelcome, rules: channelRules },
  });

  const existingConfig = getGuildConfig(guildId);

  const modal2 = new ModalBuilder()
    .setCustomId(`setup_modal_2:${guildId}`)
    .setTitle("⚙️ Setup — Verification & Quiz")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channel_verification")
          .setLabel("Verification Channel ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(existingConfig.channels.verification || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quiz_pass_percentage")
          .setLabel("Quiz Pass Percentage (1-100)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("80")
          .setRequired(true)
          .setMaxLength(3)
          .setValue(String(existingConfig.quiz.passPercentage))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quiz_max_attempts")
          .setLabel("Max Quiz Attempts (1-10)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("3")
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(existingConfig.quiz.maxAttempts))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("oauth2_client_secret")
          .setLabel("OAuth2 Client Secret (blank = keep current)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Leave empty to keep current")
          .setRequired(false)
          .setMaxLength(60)
          .setValue(getGlobalConfig().oauth2.clientSecret || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("oauth2_redirect_uri")
          .setLabel("OAuth2 Redirect URI (blank = keep current)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("https://your-domain.com/oauth/callback")
          .setRequired(false)
          .setMaxLength(200)
          .setValue(getGlobalConfig().oauth2.redirectUri || "")
      ),
    );

  await interaction.showModal(modal2);
  return true;
}

async function handleModal2(interaction: any): Promise<boolean> {
  const guildId = interaction.customId.split(":")[1];
  const channelVerification = interaction.fields.getTextInputValue("channel_verification").trim();
  const quizPassPct = parseInt(interaction.fields.getTextInputValue("quiz_pass_percentage").trim(), 10);
  const quizMaxAttempts = parseInt(interaction.fields.getTextInputValue("quiz_max_attempts").trim(), 10);
  const oauth2Secret = interaction.fields.getTextInputValue("oauth2_client_secret").trim();
  const oauth2Redirect = interaction.fields.getTextInputValue("oauth2_redirect_uri").trim();

  const idRegex = /^\d{17,20}$/;
  if (!idRegex.test(channelVerification)) {
    await interaction.reply({ content: "❌ Verification Channel ID is not valid. Run /setup again.", ephemeral: true });
    return true;
  }
  if (isNaN(quizPassPct) || quizPassPct < 1 || quizPassPct > 100) {
    await interaction.reply({ content: "❌ Pass percentage must be 1-100. Run /setup again.", ephemeral: true });
    return true;
  }
  if (isNaN(quizMaxAttempts) || quizMaxAttempts < 1 || quizMaxAttempts > 10) {
    await interaction.reply({ content: "❌ Max attempts must be 1-10. Run /setup again.", ephemeral: true });
    return true;
  }

  const key = `${interaction.user.id}:${guildId}`;
  const temp = (globalThis as any).__setupTemp?.get(key);
  if (!temp) {
    await interaction.reply({ content: "❌ Setup session expired. Run /setup again.", ephemeral: true });
    return true;
  }

  const existingConfig = getGuildConfig(guildId);

  saveGuildConfig(guildId, {
    roles: temp.roles,
    channels: { ...temp.channels, verification: channelVerification },
    quiz: {
      maxAttempts: quizMaxAttempts,
      passPercentage: quizPassPct,
      questions: existingConfig.quiz.questions.length ? existingConfig.quiz.questions : existingConfig.quiz.questions,
    },
    termsAndConditions: existingConfig.termsAndConditions,
  });

  // Save OAuth2 globally if changed
  if (oauth2Secret || oauth2Redirect) {
    const env = loadEnv?.();
    // Write to .env
    const { resolve } = await import("path");
    const { readFileSync, writeFileSync, existsSync } = await import("fs");
    const envPath = resolve(import.meta.dir, "../.env");
    const envObj: Record<string, string> = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        envObj[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
      }
    }
    if (oauth2Secret) envObj.OAUTH2_CLIENT_SECRET = oauth2Secret;
    if (oauth2Redirect) envObj.OAUTH2_REDIRECT_URI = oauth2Redirect;
    writeFileSync(envPath, Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join("\n"));

    // Update in-memory
    const g = getGlobalConfig();
    if (oauth2Secret) g.oauth2.clientSecret = oauth2Secret;
    if (oauth2Redirect) g.oauth2.redirectUri = oauth2Redirect;
  }

  (globalThis as any).__setupTemp?.delete(key);

  await interaction.reply({
    content: `🎉 **Setup Complete for this server!**\n\n` +
      `**Roles:**\n🔴 Unverified: <@&${temp.roles.unverified}>\n` +
      `🟢 Verified: <@&${temp.roles.verified}>\n` +
      `🛡️ Admin: <@&${temp.roles.admin}>\n\n` +
      `**Channels:**\n👋 Welcome: <#${temp.channels.welcome}>\n` +
      `📜 Rules: <#${temp.channels.rules}>\n` +
      `✅ Verification: <#${channelVerification}>\n\n` +
      `**Quiz:** ${existingConfig.quiz.questions.length} questions, ${quizPassPct}% pass, ${quizMaxAttempts} attempts\n` +
      `**OAuth2:** ${oauth2Secret ? "✅ configured" : "⚠️ not set"}`,
    ephemeral: true,
  });

  return true;
}

// Dynamic import helper
async function loadEnv() {
  const { readFileSync, existsSync } = await import("fs");
  const { resolve } = await import("path");
  const envPath = resolve(import.meta.dir, "../.env");
  const env: Record<string, string> = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return env;
}
