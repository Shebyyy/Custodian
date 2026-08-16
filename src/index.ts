// @ts-nocheck — discord.js type quirks with bun
import {
  Client, Events, GatewayIntentBits, Interaction, MessageFlags, Partials,
  SlashCommandBuilder,
} from "discord.js";

import { getGlobalConfig, setClientId, getGuildConfig, loadChannelMappings, saveChannelMappings } from "./config.js";
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
const restoreModule = new RestoreModule(client);
const migrationModule = new MigrationModule(client);

// ─── Slash Commands ───
const commands = [
  // Setup (per-guild) — uses role/channel pickers
  ...getSetupCommands(),

  // Module 1: Backup (per-guild)
  new SlashCommandBuilder().setName("backup-add").setDescription("Register a channel for backup")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to back up").setRequired(true)),
  new SlashCommandBuilder().setName("backup-remove").setDescription("Unregister a channel from backup")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to remove").setRequired(true)),
  new SlashCommandBuilder().setName("backup-list").setDescription("List all backed up channels"),
  new SlashCommandBuilder().setName("backup-export").setDescription("Export a channel's backup as JSON")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to export").setRequired(true)),

  // Module 2: Members (per-guild)
  new SlashCommandBuilder().setName("members-stats").setDescription("View member statistics for this server"),

  // Module 3: Verification (per-guild)
  new SlashCommandBuilder().setName("verify-stats").setDescription("View verification stats for this server"),
  new SlashCommandBuilder().setName("verify-manual").setDescription("Manually verify a user")
    .addUserOption((o) => o.setName("user").setDescription("User to verify").setRequired(true)),
  new SlashCommandBuilder().setName("verify-flagged").setDescription("View users flagged for review"),

  // Rules & Quiz management (admin)
  getPostVerifyCommand(),
  getSetFinalQuestionCommand(),
  getQuizAddCommand(),
  getQuizListCommand(),
  getQuizRemoveCommand(),

  // Module 5: Migration (global — tokens work across servers)
  new SlashCommandBuilder().setName("migrate-add").setDescription("Add authorized users to a server directly")
    .addStringOption((o) => o.setName("guild-id").setDescription("Target server ID").setRequired(true))
    .addStringOption((o) => o.setName("role-id").setDescription("Role to assign on join (optional)")),
  new SlashCommandBuilder().setName("migrate-status").setDescription("View OAuth2 authorization status"),

  // Module 4: Restore (per-guild)
  new SlashCommandBuilder().setName("restore-map").setDescription("Map old channel to new channel")
    .addChannelOption((o) => o.setName("source").setDescription("Old channel").setRequired(true))
    .addChannelOption((o) => o.setName("target").setDescription("New channel").setRequired(true)),
  new SlashCommandBuilder().setName("restore-unmap").setDescription("Remove a channel mapping")
    .addChannelOption((o) => o.setName("source").setDescription("Old channel").setRequired(true)),
  new SlashCommandBuilder().setName("restore-list").setDescription("List all mappings"),
  new SlashCommandBuilder().setName("restore-preview").setDescription("Preview a restore (dry run)")
    .addChannelOption((o) => o.setName("source").setDescription("Old channel").setRequired(true)),
  new SlashCommandBuilder().setName("restore-run").setDescription("Run restore for a mapped channel")
    .addChannelOption((o) => o.setName("source").setDescription("Old channel").setRequired(true)),
];

// ─── Ready ───
client.once(Events.ClientReady, async () => {
  console.log(`✅ Custodian is online as ${client.user?.tag}`);

  if (client.user) {
    setClientId(client.user.id);
    console.log(`📝 Client ID: ${client.user.id}`);
  }

  try {
    // Clear stale guild-specific commands (from accidental per-guild registration)
    // Guild commands override global — must delete them
    for (const [id, guild] of client.guilds.cache) {
      try {
        const existing = await guild.commands.fetch();
        if (existing.size > 0) {
          await guild.commands.set([]);
          console.log(`🧹 Cleared ${existing.size} stale guild commands in ${guild.name}`);
        } else {
          console.log(`✓ No guild commands in ${guild.name}`);
        }
      } catch (err: any) {
        console.warn(`⚠ Failed to fetch guild commands for ${guild.name}: ${err.message}`);
        // Force delete via REST API as fallback
        try {
          await client.rest.put(`/applications/${client.user!.id}/guilds/${id}/commands`, []);
          console.log(`🧹 Force-cleared guild commands in ${guild.name} via REST`);
        } catch (err2: any) {
          console.warn(`⚠ REST fallback also failed: ${err2.message}`);
        }
      }
    }
    // Register global commands (works for all servers)
    await client.application?.commands.set(commands as any);
    console.log(`📝 ${commands.length} slash commands registered`);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }

  // Show which guilds the bot is in
  console.log(`🌍 Serving ${client.guilds.cache.size} server(s):`);
  for (const [id, guild] of client.guilds.cache) {
    const cfg = getGuildConfig(id);
    console.log(`  → ${guild.name} (${id}) — ${cfg.isSetup ? "✅ configured" : "⚠️ not set up"}`);
  }
});

// ─── Interaction Handler ───
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // Handle setup modal submissions
  if (interaction.isModalSubmit()) {
    const handled = await handleSetupInteraction(interaction, client);
    if (handled) return;
    const handled2 = await handleManagementModal(interaction, client);
    if (handled2) return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;
  const guildId = interaction.guild?.id || "";

  // Don't deferReply for commands that show their own modal
  if (commandName !== "setup" && commandName !== "post-verify" && commandName !== "quiz-add" && commandName !== "set-final-question") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  try {
    switch (commandName) {
      // ── Setup (per-guild) ──
      case "setup":
        await handleSetupCommand(interaction, client);
        break;

      // ── Module 1: Backup ──
      case "backup-add": {
        const ch = options.getChannel("channel", true);
        await interaction.editReply(channelBackup.addChannel(ch.id, ch.name || ch.id, guildId));
        break;
      }
      case "backup-remove": {
        const ch = options.getChannel("channel", true);
        await interaction.editReply(channelBackup.removeChannel(ch.id));
        break;
      }
      case "backup-list": {
        await interaction.editReply(channelBackup.listChannels());
        break;
      }
      case "backup-export": {
        const ch = options.getChannel("channel", true);
        const { content, filename } = channelBackup.exportChannel(ch.id);
        if (content.length > 2000) {
          const buffer = Buffer.from(content, "utf-8");
          await interaction.editReply({ content: `📦 Backup for <#${ch.id}>:`, files: [{ attachment: buffer, name: filename }] });
        } else {
          await interaction.editReply(content);
        }
        break;
      }

      // ── Module 2: Members (per-guild) ──
      case "members-stats":
        await interaction.editReply(memberTracking.getStats(guildId));
        break;

      // ── Module 3: Verification (per-guild) ──
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

      // ── Rules & Quiz Management (admin) ──
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

      // ── Module 5: Migration (global) ──
      case "migrate-add": {
        const targetGuildId = options.getString("guild-id", true);
        const roleId = options.getString("role-id") || undefined;
        await interaction.editReply("🚀 Starting migration...");
        const result = await migrationModule.migrateAdd(targetGuildId, roleId);
        await interaction.editReply(result);
        break;
      }
      case "migrate-status":
        await interaction.editReply(migrationModule.getStatus());
        break;

      // ── Module 4: Restore (per-guild) ──
      case "restore-map": {
        const source = options.getChannel("source", true);
        const target = options.getChannel("target", true);
        const mappings = loadChannelMappings(guildId);
        mappings.push({ sourceChannelId: source.id, targetChannelId: target.id, isForum: false });
        saveChannelMappings(guildId, mappings);
        await interaction.editReply(`✅ Mapped <#${source.id}> → <#${target.id}>`);
        break;
      }
      case "restore-unmap": {
        const source = options.getChannel("source", true);
        const mappings = loadChannelMappings(guildId).filter((m) => m.sourceChannelId !== source.id);
        saveChannelMappings(guildId, mappings);
        await interaction.editReply(`✅ Unmapped <#${source.id}>`);
        break;
      }
      case "restore-list": {
        const mappings = loadChannelMappings(guildId);
        if (!mappings.length) {
          await interaction.editReply("📋 No channel mappings");
        } else {
          const list = mappings.map((m) => `• <#${m.sourceChannelId}> → <#${m.targetChannelId}>${m.isForum ? " (forum)" : ""}`).join("\n");
          await interaction.editReply(`📋 **Channel Mappings:**\n${list}`);
        }
        break;
      }

      case "restore-preview": {
        const source = options.getChannel("source", true);
        const result = await restoreModule.preview(source.id);
        await interaction.editReply(result);
        break;
      }
      case "restore-run": {
        const source = options.getChannel("source", true);
        await interaction.editReply("🔄 Restoring...");
        const result = await restoreModule.restore(source.id);
        await interaction.editReply(result);
        break;
      }

      default:
        await interaction.editReply("❓ Unknown command");
    }
  } catch (err: any) {
    console.error("Command error:", err);
    try {
      await interaction.editReply(`❌ Error: ${err.message}`);
    } catch {}
  }
});

// ─── Start OAuth2 callback server ───
try {
  if (globalConfig.oauth2.clientSecret && globalConfig.oauth2.redirectUri) {
    await import("./oauth-callback.js");
  } else {
    console.log("⚠️ OAuth2 not configured — authorization won't work. Set OAUTH2_CLIENT_SECRET and OAUTH2_REDIRECT_URI in .env");
  }
} catch (e: any) {
  console.log(`⚠️ OAuth2 callback server not started: ${e.message}`);
}

// ─── Login ───
client.login(globalConfig.token).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
