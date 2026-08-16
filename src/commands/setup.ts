// @ts-nocheck — discord.js type quirks with bun
import {
  Client, CommandInteraction, Interaction,
  SlashCommandBuilder, PermissionFlagsBits,
} from "discord.js";
import { getGuildConfig, saveGuildConfig, getGlobalConfig } from "../config.js";

/**
 * /setup — Configure Custodian for this server.
 * Uses Discord's native role/channel pickers instead of manual ID input.
 * 2 channels: verification (welcome + buttons) + logs (detailed pass/fail info)
 */

export function getSetupCommands() {
  return [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Configure Custodian for this server")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      // Roles
      .addRoleOption((o) => o.setName("unverified-role").setDescription("Role assigned to new/unverified members").setRequired(true))
      .addRoleOption((o) => o.setName("verified-role").setDescription("Role assigned after verification").setRequired(true))
      .addRoleOption((o) => o.setName("admin-role").setDescription("Role for admins who can manage Custodian").setRequired(true))
      // Channels
      .addChannelOption((o) => o.setName("verification-channel").setDescription("Channel where welcome message + verify buttons are sent").setRequired(true))
      .addChannelOption((o) => o.setName("logs-channel").setDescription("Channel where detailed logs are sent (pass/fail details)").setRequired(true))
      // Quiz settings
      .addIntegerOption((o) => o.setName("max-attempts").setDescription("Max quiz attempts per user (1-10)").setMinValue(1).setMaxValue(10).setRequired(false)),
  ];
}

export async function handleSetupCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "❌ Run this command in a server.", ephemeral: true });
    return;
  }

  const existingConfig = getGuildConfig(guild.id);

  const unverifiedRole = interaction.options.getRole("unverified-role", true);
  const verifiedRole = interaction.options.getRole("verified-role", true);
  const adminRole = interaction.options.getRole("admin-role", true);
  const verificationChannel = interaction.options.getChannel("verification-channel", true);
  const logsChannel = interaction.options.getChannel("logs-channel", true);
  const maxAttempts = interaction.options.getInteger("max-attempts") ?? existingConfig.quiz.maxAttempts;

  // Save config
  saveGuildConfig(guild.id, {
    roles: {
      unverified: unverifiedRole.id,
      verified: verifiedRole.id,
      admin: adminRole.id,
    },
    channels: {
      verification: verificationChannel.id,
      logs: logsChannel.id,
    },
    quiz: {
      maxAttempts,
      questions: existingConfig.quiz.questions,
      finalQuestion: existingConfig.quiz.finalQuestion,
    },
    termsAndConditions: existingConfig.termsAndConditions,
  });

  const questionCount = existingConfig.quiz.questions.length;

  await interaction.reply({
    content:
      `🎉 **Setup Complete!**\n\n` +
      `**Roles:**\n🔴 Unverified: <@&${unverifiedRole.id}>\n` +
      `🟢 Verified: <@&${verifiedRole.id}>\n` +
      `🛡️ Admin: <@&${adminRole.id}>\n\n` +
      `**Channels:**\n✅ Verification: <#${verificationChannel.id}>\n📋 Logs: <#${logsChannel.id}>\n\n` +
      `**Quiz:** ${questionCount} question(s) in pool, ${maxAttempts} attempt(s), all must be correct\n\n` +
      `💡 Use **/set-rules** to customize server rules\n` +
      `💡 Use **/quiz-add** to add custom quiz questions\n\n` +
      (getGlobalConfig().oauth2.clientSecret
        ? "🔐 OAuth2: ✅ configured"
        : "🔐 OAuth2: ⚠️ not set — migration won't work"),
    ephemeral: true,
  });
}

export async function handleSetupInteraction(interaction: Interaction, client: Client): Promise<boolean> {
  return false;
}
