// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Client, CommandInteraction, Interaction,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { getConfig, saveConfig, saveGuildId } from "../config.js";

/**
 * /setup — One-shot setup via modal form(s).
 * Admin types /setup → modal popup → fill in IDs → save. Done.
 *
 * Discord modals support max 5 text inputs per modal,
 * so we use 2 modals: Modal 1 = roles + welcome, Modal 2 = channels + quiz.
 */

export function getSetupCommands() {
  return [
    {
      name: "setup" as const,
      description: "Configure Custodian (admin only)",
    },
  ];
}

export async function handleSetupCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const config = getConfig();

  // Find the guild
  const guilds = client.guilds.cache;
  if (!guilds.size) {
    await interaction.reply({ content: "❌ I'm not in any server! Invite me first.", ephemeral: true });
    return;
  }
  const guild = guilds.first()!;

  // Store client ID from the bot user
  if (client.user && !config.clientId) {
    saveConfig({ clientId: client.user.id });
  }

  // Show first modal: Roles + Welcome Channel (5 fields max)
  const modal = new ModalBuilder()
    .setCustomId("setup_modal_1")
    .setTitle("⚙️ Custodian Setup — Roles & Channels")
    .addComponents(
      // Field 1: Unverified Role ID
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_unverified")
          .setLabel("Unverified Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(config.roles.unverified || "")
      ),
      // Field 2: Verified Role ID
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_verified")
          .setLabel("Verified Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(config.roles.verified || "")
      ),
      // Field 3: Admin Role ID
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_admin")
          .setLabel("Admin Role ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(config.roles.admin || "")
      ),
      // Field 4: Welcome Channel ID
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channel_welcome")
          .setLabel("Welcome Channel ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(config.channels.welcome || "")
      ),
      // Field 5: Rules Channel ID
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("channel_rules")
          .setLabel("Rules Channel ID")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. 123456789012345678")
          .setRequired(true)
          .setMaxLength(25)
          .setValue(config.channels.rules || "")
      ),
    );

  // Save guild ID
  saveGuildId(guild.id);

  await interaction.showModal(modal);
}

export async function handleSetupInteraction(interaction: Interaction, client: Client): Promise<boolean> {
  // Handle Modal 1 submission (roles + welcome + rules)
  if (interaction.isModalSubmit() && interaction.customId === "setup_modal_1") {
    return await handleModal1(interaction, client) || true;
  }

  // Handle Modal 2 submission (verification channel + quiz)
  if (interaction.isModalSubmit() && interaction.customId === "setup_modal_2") {
    return await handleModal2(interaction) || true;
  }

  return false;
}

async function handleModal1(interaction: any, client: Client): Promise<boolean> {
  const roleUnverified = interaction.fields.getTextInputValue("role_unverified").trim();
  const roleVerified = interaction.fields.getTextInputValue("role_verified").trim();
  const roleAdmin = interaction.fields.getTextInputValue("role_admin").trim();
  const channelWelcome = interaction.fields.getTextInputValue("channel_welcome").trim();
  const channelRules = interaction.fields.getTextInputValue("channel_rules").trim();

  // Validate — basic check that they look like Discord IDs (numeric)
  const idRegex = /^\d{17,20}$/;
  for (const [name, val] of [
    ["Unverified Role", roleUnverified],
    ["Verified Role", roleVerified],
    ["Admin Role", roleAdmin],
    ["Welcome Channel", channelWelcome],
    ["Rules Channel", channelRules],
  ]) {
    if (!idRegex.test(val)) {
      await interaction.reply({
        content: `❌ "${name}" doesn't look like a valid Discord ID. It should be a 17-20 digit number like \`123456789012345678\`.\n\nRun /setup again.`,
        ephemeral: true,
      });
      return true;
    }
  }

  // Temporarily save modal 1 values — we'll store them in a map and show modal 2
  // Use a simple map keyed by user+guild for safety
  const key = `${interaction.user.id}`;
  if (!(globalThis as any).__setupTemp) (globalThis as any).__setupTemp = new Map();
  (globalThis as any).__setupTemp.set(key, {
    roles: { unverified: roleUnverified, verified: roleVerified, admin: roleAdmin },
    channels: { welcome: channelWelcome, rules: channelRules },
  });

  const config = getConfig();

  // Show Modal 2: Verification Channel + Quiz Settings (5 fields)
  const modal2 = new ModalBuilder()
    .setCustomId("setup_modal_2")
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
          .setValue(config.channels.verification || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quiz_pass_percentage")
          .setLabel("Quiz Pass Percentage (e.g. 80)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("80")
          .setRequired(true)
          .setMaxLength(3)
          .setValue(String(config.quiz.passPercentage))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("quiz_max_attempts")
          .setLabel("Max Quiz Attempts (e.g. 3)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("3")
          .setRequired(true)
          .setMaxLength(2)
          .setValue(String(config.quiz.maxAttempts))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("oauth2_client_secret")
          .setLabel("OAuth2 Client Secret (from Dev Portal)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Leave empty to keep current")
          .setRequired(false)
          .setMaxLength(60)
          .setValue(config.oauth2.clientSecret || "")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("oauth2_redirect_uri")
          .setLabel("OAuth2 Redirect URI")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("https://your-domain.com/oauth/callback")
          .setRequired(false)
          .setMaxLength(200)
          .setValue(config.oauth2.redirectUri || "")
      ),
    );

  await interaction.showModal(modal2);
  return true;
}

async function handleModal2(interaction: any): Promise<boolean> {
  const channelVerification = interaction.fields.getTextInputValue("channel_verification").trim();
  const quizPassPct = parseInt(interaction.fields.getTextInputValue("quiz_pass_percentage").trim(), 10);
  const quizMaxAttempts = parseInt(interaction.fields.getTextInputValue("quiz_max_attempts").trim(), 10);
  const oauth2Secret = interaction.fields.getTextInputValue("oauth2_client_secret").trim();
  const oauth2Redirect = interaction.fields.getTextInputValue("oauth2_redirect_uri").trim();

  // Validate verification channel ID
  const idRegex = /^\d{17,20}$/;
  if (!idRegex.test(channelVerification)) {
    await interaction.reply({
      content: `❌ "Verification Channel ID" doesn't look like a valid Discord ID. Run /setup again.`,
      ephemeral: true,
    });
    return true;
  }

  // Validate quiz settings
  if (isNaN(quizPassPct) || quizPassPct < 1 || quizPassPct > 100) {
    await interaction.reply({ content: "❌ Pass percentage must be 1-100. Run /setup again.", ephemeral: true });
    return true;
  }
  if (isNaN(quizMaxAttempts) || quizMaxAttempts < 1 || quizMaxAttempts > 10) {
    await interaction.reply({ content: "❌ Max attempts must be 1-10. Run /setup again.", ephemeral: true });
    return true;
  }

  // Retrieve modal 1 temp data
  const key = `${interaction.user.id}`;
  const temp = (globalThis as any).__setupTemp?.get(key);
  if (!temp) {
    await interaction.reply({ content: "❌ Setup session expired. Run /setup again.", ephemeral: true });
    return true;
  }

  // Merge and save everything
  const config = getConfig();
  const defaultQuiz = [
    { id: 1, question: "Is it okay to spam?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
    { id: 2, question: "Be respectful to everyone?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
    { id: 3, question: "NSFW allowed?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
  ];

  saveConfig({
    guildId: config.guildId,
    roles: temp.roles,
    channels: {
      ...temp.channels,
      verification: channelVerification,
    },
    quiz: {
      maxAttempts: quizMaxAttempts,
      passPercentage: quizPassPct,
      questions: config.quiz?.questions?.length ? config.quiz.questions : defaultQuiz,
    },
    termsAndConditions: "## Server Rules\n\n1. Be respectful to all members.\n2. No spam, self-promotion, or unsolicited DMs.\n3. No NSFW or offensive content.\n4. Follow Discord's Terms of Service.\n5. Listen to staff — their decisions are final.\n6. Use channels for their intended purpose.\n\n**Breaking these rules may result in warnings, kicks, or bans.**",
  });

  // Save OAuth2 settings separately (only update if provided)
  if (oauth2Secret || oauth2Redirect) {
    saveConfig({
      oauth2: {
        clientSecret: oauth2Secret || config.oauth2.clientSecret,
        redirectUri: oauth2Redirect || config.oauth2.redirectUri,
      },
    });
  }

  // Clean up temp data
  (globalThis as any).__setupTemp?.delete(key);

  const unvRole = client.guilds.cache.get(config.guildId)?.roles.cache.get(temp.roles.unverified);
  const verRole = client.guilds.cache.get(config.guildId)?.roles.cache.get(temp.roles.verified);
  const admRole = client.guilds.cache.get(config.guildId)?.roles.cache.get(temp.roles.admin);

  await interaction.reply({
    content: `🎉 **Custodian Setup Complete!**\n\n` +
      `**Roles:**\n` +
      `🔴 Unverified: ${unvRole ? `<@&${temp.roles.unverified}>` : temp.roles.unverified}\n` +
      `🟢 Verified: ${verRole ? `<@&${temp.roles.verified}>` : temp.roles.verified}\n` +
      `🛡️ Admin: ${admRole ? `<@&${temp.roles.admin}>` : temp.roles.admin}\n\n` +
      `**Channels:**\n` +
      `👋 Welcome: <#${temp.channels.welcome}>\n` +
      `📜 Rules: <#${temp.channels.rules}>\n` +
      `✅ Verification: <#${channelVerification}>\n\n` +
      `**Quiz:** ${config.quiz.questions.length} questions, ${quizPassPct}% pass, ${quizMaxAttempts} attempts\n` +
      `**OAuth2:** ${oauth2Secret ? "✅ configured" : "⚠️ not set — bot authorization won't work"}` +
      (oauth2Secret && !oauth2Redirect ? `\n⚠️ OAuth2 redirect URI not set — bot authorization won't work` : "") +
      `\n\n_Saved to config/bot.config.json_`,
    ephemeral: true,
  });

  return true;
}
