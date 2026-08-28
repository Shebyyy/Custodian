// @ts-nocheck — discord.js type quirks with bun
import {
  Client, Events, GatewayIntentBits, Interaction, MessageFlags, Partials,
  SlashCommandBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from "discord.js";

import { getGlobalConfig, setClientId, getGuildConfig } from "./config.js";
import { ChannelBackupModule } from "./modules/channel-backup.js";
import { MemberTrackingModule } from "./modules/member-tracking.js";
import { VerificationModule } from "./modules/verification.js";
import { RestoreModule } from "./modules/restore.js";
import { MigrationModule } from "./modules/migration.js";
import { getSetupCommands, handleSetupCommand, handleSetupInteraction } from "./commands/setup.js";
import {
  getPostVerifyCommand, handlePostVerifyCommand,
  getSetFinalQuestionCommand, handleSetFinalQuestionCommand,
  getQuizAddCommand, handleQuizAddCommand,
  getQuizListCommand, handleQuizListCommand,
  getQuizRemoveCommand, handleQuizRemoveCommand,
  getQuizToggleCommand, handleQuizToggleCommand,
  handleManagementModal,
} from "./commands/quiz-management.js";

// ─── Load Global Config ───
const globalConfig = getGlobalConfig();

// ─── Create Client ───
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
});

// ─── Init Modules ───
const channelBackup = new ChannelBackupModule(client);
const memberTracking = new MemberTrackingModule(client);
const verification = new VerificationModule(client);
const restoreModule = new RestoreModule(client, channelBackup);
const migrationModule = new MigrationModule(client);

// ─── Slash Commands ───
const commands = [
  // Setup (per-guild)
  ...getSetupCommands(),

  // ── Backup Commands ──
  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Enable or disable backup for this server")
    .addSubcommand((s) => s.setName("enable").setDescription("Enable backup for this server"))
    .addSubcommand((s) => s.setName("disable").setDescription("Disable backup for this server"))
    .addSubcommand((s) => s.setName("status").setDescription("View backup status and stats"))
    .addSubcommand((s) => s
      .setName("fetch")
      .setDescription("Backfill old messages from channel(s)")
      .addChannelOption((o) => o
        .setName("channel")
        .setDescription("Specific channel to fetch (omits = all channels)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
      )
    )
    .addSubcommand((s) => s.setName("purge").setDescription("Delete all backup data for this server"))
    .addSubcommand((s) => s.setName("export").setDescription("Export a channel's backup as JSON")
      .addChannelOption((o) => o.setName("channel").setDescription("Channel to export").setRequired(true))
    ),

  // ── Restore Commands ──
  new SlashCommandBuilder()
    .setName("restore")
    .setDescription("Start the restore flow — map backed-up channels to current server"),
  new SlashCommandBuilder()
    .setName("restore-mappings")
    .setDescription("View current channel mappings"),
  new SlashCommandBuilder()
    .setName("restore-clear")
    .setDescription("Clear all channel mappings"),
  new SlashCommandBuilder()
    .setName("restore-preview")
    .setDescription("Preview backed-up messages (dry run)")
    .addStringOption((o) => o.setName("channel-id").setDescription("Channel ID to preview").setRequired(true))
    .addIntegerOption((o) => o.setName("count").setDescription("Number of messages to show").setMinValue(1).setMaxValue(50)),

  // ── Member Commands ──
  new SlashCommandBuilder().setName("members-stats").setDescription("View member statistics"),

  // ── Verification Commands ──
  new SlashCommandBuilder().setName("verify-stats").setDescription("View verification stats"),
  new SlashCommandBuilder().setName("verify-manual").setDescription("Manually verify a user")
    .addUserOption((o) => o.setName("user").setDescription("User to verify").setRequired(true)),
  new SlashCommandBuilder().setName("verify-flagged").setDescription("View users flagged for review"),

  // ── Quiz Management ──
  getPostVerifyCommand(),
  getSetFinalQuestionCommand(),
  getQuizAddCommand(),
  getQuizListCommand(),
  getQuizRemoveCommand(),
  getQuizToggleCommand(),

  // ── Migration Commands ──
  new SlashCommandBuilder().setName("migrate-add").setDescription("Add authorized users to a server directly")
    .addStringOption((o) => o.setName("guild-id").setDescription("Target server ID").setRequired(true))
    .addStringOption((o) => o.setName("role-id").setDescription("Role to assign on join (optional)")),
  new SlashCommandBuilder().setName("migrate-status").setDescription("View OAuth2 authorization status"),
];

// ─── Ready ───
client.once(Events.ClientReady, async () => {
  console.log(`Custodian is online as ${client.user?.tag}`);

  if (client.user) {
    setClientId(client.user.id);
    console.log(`Client ID: ${client.user.id}`);
  }

  try {
    // Clear stale guild-specific commands
    for (const [id, guild] of client.guilds.cache) {
      try {
        const existing = await guild.commands.fetch();
        if (existing.size > 0) {
          await guild.commands.set([]);
          console.log(`Cleared ${existing.size} stale guild commands in ${guild.name}`);
        }
      } catch (err: any) {
        console.warn(`Failed to fetch guild commands for ${guild.name}: ${err.message}`);
        try {
          await client.rest.put(`/applications/${client.user!.id}/guilds/${id}/commands`, []);
        } catch {}
      }
    }
    // Register global commands
    await client.application?.commands.set(commands as any);
    console.log(`${commands.length} slash commands registered`);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }

  // Show which guilds the bot is in
  console.log(`Serving ${client.guilds.cache.size} server(s):`);
  for (const [id, guild] of client.guilds.cache) {
    const cfg = getGuildConfig(id);
    console.log(`  ${guild.name} (${id}) — ${cfg.isSetup ? "configured" : "not set up"}`);
  }
});

// ─── Interaction Handler ───
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // Handle modal submissions first
  if (interaction.isModalSubmit()) {
    const handled = await handleSetupInteraction(interaction, client);
    if (handled) return;
    const handled2 = await handleManagementModal(interaction, client);
    if (handled2) return;

    // Backup purge confirmation modal
    if (interaction.customId === "backup_purge_confirm") {
      const confirm = interaction.fields.getTextInputValue("purge_confirm");
      const guildId = interaction.guild?.id;
      if (confirm !== "PURGE" || !guildId) {
        await interaction.reply({ content: "Purge cancelled. You must type exactly `PURGE`.", flags: MessageFlags.Ephemeral });
        return;
      }
      const result = channelBackup.purgeBackup(guildId);
      await interaction.reply({
        content: `Purged **${result.channelCount}** channels and **${result.messageCount}** messages from backup.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    return;
  }

  // Handle restore flow interactions (select menus, buttons)
  if (!interaction.isChatInputCommand()) {
    if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isButton()) {
      try {
        const handled = await restoreModule.handleInteraction(interaction as any);
        if (handled) return;
      } catch (err: any) {
        console.error("Restore interaction error:", err);
        try {
          await (interaction as any).reply({ content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral });
        } catch {}
      }
    }
    return;
  }

  // Slash commands
  const { commandName, options } = interaction;
  const subcommand = options.getSubcommand(false);
  const guildId = interaction.guild?.id || "";

  // Don't deferReply for commands that show their own modal or need the interaction token
  const needsDefer = commandName !== "setup"
    && commandName !== "post-verify"
    && commandName !== "quiz-add"
    && commandName !== "set-final-question"
    && commandName !== "quiz-toggle"
    && !(commandName === "backup" && subcommand === "purge");
  if (needsDefer) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  try {
    switch (commandName) {
      // ── Setup ──
      case "setup":
        await handleSetupCommand(interaction, client);
        break;

      // ── Backup ──
      case "backup": {
        switch (subcommand) {
          case "enable": {
            if (!interaction.guild) break;
            const result = channelBackup.enableBackup(interaction.guild);
            await interaction.editReply(result);
            break;
          }
          case "disable": {
            if (!guildId) break;
            const result = channelBackup.disableBackup(guildId);
            await interaction.editReply(result);
            break;
          }
          case "status": {
            const payload = channelBackup.getStatusEmbed(guildId);
            await interaction.editReply(payload);
            break;
          }
          case "fetch": {
            if (!interaction.guild) break;
            const targetChannel = options.getChannel("channel") as any;
            await interaction.editReply("Starting backfill... This may take a while depending on how many messages exist.");
            const result = await channelBackup.fetchHistorical(interaction.guild, targetChannel || undefined);
            await interaction.editReply(result);
            break;
          }
          case "purge": {
            if (!guildId) break;
            // Show confirmation modal
            const modal = new ModalBuilder()
              .setCustomId("backup_purge_confirm")
              .setTitle("Confirm Purge")
              .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                  new TextInputBuilder()
                    .setCustomId("purge_confirm")
                    .setLabel(`Type "PURGE" to delete all backup data for this server`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder("PURGE")
                )
              );
            await interaction.showModal(modal);
            break;
          }
          case "export": {
            const ch = options.getChannel("channel", true);
            const { content, filename } = channelBackup.exportChannel(ch.id);
            if (content.length > 2000) {
              const buffer = Buffer.from(content, "utf-8");
              await interaction.editReply({ content: `Backup for <#${ch.id}>:`, files: [{ attachment: buffer, name: filename }] });
            } else {
              await interaction.editReply(content);
            }
            break;
          }
        }
        break;
      }

      // ── Restore ──
      case "restore": {
        await restoreModule.startRestoreFlow(interaction);
        break;
      }
      case "restore-mappings": {
        await interaction.editReply(restoreModule.listMappings(guildId));
        break;
      }
      case "restore-clear": {
        const result = restoreModule.clearMappings(guildId);
        await interaction.editReply(result);
        break;
      }
      case "restore-preview": {
        const channelId = options.getString("channel-id", true);
        const count = options.getInteger("count") || 10;
        const result = await restoreModule.preview(channelId, count);
        await interaction.editReply(result);
        break;
      }

      // ── Members ──
      case "members-stats":
        await interaction.editReply(memberTracking.getStats(guildId));
        break;

      // ── Verification ──
      case "verify-stats":
        await interaction.editReply(verification.getStats(guildId));
        break;
      case "verify-manual": {
        const user = options.getUser("user", true);
        const result = await verification.manualVerify(user.id, guildId);
        await interaction.editReply(result);
        break;
      }
      case "verify-flagged":
        await interaction.editReply(verification.getFlagged(guildId));
        break;

      // ── Quiz Management ──
      case "post-verify":
        await handlePostVerifyCommand(interaction, client);
        break;
      case "set-final-question":
        await handleSetFinalQuestionCommand(interaction, client);
        break;
      case "quiz-add":
        await handleQuizAddCommand(interaction, client);
        break;
      case "quiz-list":
        await handleQuizListCommand(interaction, client);
        break;
      case "quiz-remove":
        await handleQuizRemoveCommand(interaction, client);
        break;
      case "quiz-toggle":
        await handleQuizToggleCommand(interaction);
        break;

      // ── Migration ──
      case "migrate-add": {
        const targetGuildId = options.getString("guild-id", true);
        const roleId = options.getString("role-id") || undefined;
        await interaction.editReply("Starting migration...");
        const result = await migrationModule.migrateAdd(targetGuildId, roleId);
        await interaction.editReply(result);
        break;
      }
      case "migrate-status":
        await interaction.editReply(migrationModule.getStatus());
        break;

      default:
        await interaction.editReply("Unknown command");
    }
  } catch (err: any) {
    console.error("Command error:", err);
    try {
      await interaction.editReply(`Error: ${err.message}`);
    } catch {}
  }
});

// ─── Start OAuth2 callback server ───
try {
  if (globalConfig.oauth2.clientSecret && globalConfig.oauth2.redirectUri) {
    await import("./oauth-callback.js");
  } else {
    console.log("OAuth2 not configured — set OAUTH2_CLIENT_SECRET and OAUTH2_REDIRECT_URI in .env");
  }
} catch (e: any) {
  console.log(`OAuth2 callback server not started: ${e.message}`);
}

// ─── Login ───
client.login(globalConfig.token).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
