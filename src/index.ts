import {
  Client, Events, GatewayIntentBits, Interaction, Partials,
  SlashCommandBuilder,
} from "discord.js";

import { loadConfig } from "./config.js";
import { ChannelBackupModule } from "./modules/channel-backup.js";
import { MemberTrackingModule } from "./modules/member-tracking.js";
import { VerificationModule } from "./modules/verification.js";
import { RestoreModule } from "./modules/restore.js";
import { getSetupCommands, handleSetupCommand, handleSetupInteraction } from "./commands/setup.js";

// ─── Load Config ───
const config = loadConfig();

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

// ─── Slash Commands ───
const setupCmds = getSetupCommands();

const commands = [
  // Setup
  new SlashCommandBuilder().setName(setupCmds[0].name).setDescription(setupCmds[0].description),

  // Module 1: Backup
  new SlashCommandBuilder().setName("backup-add").setDescription("Register a channel for backup")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to back up").setRequired(true)),
  new SlashCommandBuilder().setName("backup-remove").setDescription("Unregister a channel from backup")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to remove").setRequired(true)),
  new SlashCommandBuilder().setName("backup-list").setDescription("List all backed up channels"),
  new SlashCommandBuilder().setName("backup-export").setDescription("Export a channel's backup as JSON")
    .addChannelOption((o) => o.setName("channel").setDescription("Channel to export").setRequired(true)),

  // Module 2: Members
  new SlashCommandBuilder().setName("members-stats").setDescription("View member statistics"),
  new SlashCommandBuilder().setName("migrate-invite").setDescription("DM all stored members an invite link")
    .addStringOption((o) => o.setName("link").setDescription("Invite link").setRequired(true)),
  new SlashCommandBuilder().setName("migrate-report").setDescription("View migration report"),

  // Module 3: Verification
  new SlashCommandBuilder().setName("verify-stats").setDescription("View verification stats"),
  new SlashCommandBuilder().setName("verify-manual").setDescription("Manually verify a user")
    .addUserOption((o) => o.setName("user").setDescription("User to verify").setRequired(true)),
  new SlashCommandBuilder().setName("verify-flagged").setDescription("View users flagged for review"),

  // Module 4: Restore
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
  try {
    await client.application?.commands.set(commands as any);
    console.log(`📝 ${commands.length} slash commands registered`);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

// ─── Interaction Handler ───
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // Handle setup wizard interactions (select menus, buttons)
  if (interaction.isMessageComponent()) {
    const handled = await handleSetupInteraction(interaction, client);
    if (handled) return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, options } = interaction;

  // Don't deferReply for setup — it handles its own reply
  if (commandName !== "setup") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  try {
    switch (commandName) {
      // ── Setup ──
      case "setup":
        await handleSetupCommand(interaction, client);
        break;

      // ── Module 1: Backup ──
      case "backup-add": {
        const ch = options.getChannel("channel", true);
        await interaction.editReply(channelBackup.addChannel(ch.id, ch.name || ch.id));
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

      // ── Module 2: Members ──
      case "members-stats":
        await interaction.editReply(memberTracking.getStats());
        break;

      case "migrate-invite": {
        const link = options.getString("link", true);
        await interaction.editReply("📬 Starting...");
        const result = await memberTracking.migrateInvite(link);
        await interaction.editReply(result);
        break;
      }
      case "migrate-report":
        await interaction.editReply(memberTracking.getReport());
        break;

      // ── Module 3: Verification ──
      case "verify-stats":
        await interaction.editReply(verification.getStats());
        break;

      case "verify-manual": {
        const user = options.getUser("user", true);
        const result = await verification.manualVerify(user.id);
        await interaction.editReply(result);
        break;
      }
      case "verify-flagged":
        await interaction.editReply(verification.getFlagged());
        break;

      // ── Module 4: Restore ──
      case "restore-map": {
        const source = options.getChannel("source", true);
        const target = options.getChannel("target", true);
        await interaction.editReply(restoreModule.addMapping(source.id, target.id));
        break;
      }
      case "restore-unmap": {
        const source = options.getChannel("source", true);
        await interaction.editReply(restoreModule.removeMapping(source.id));
        break;
      }
      case "restore-list":
        await interaction.editReply(restoreModule.listMappings());
        break;

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
    await interaction.editReply(`❌ Error: ${err.message}`);
  }
});

// ─── Login ───
client.login(config.token).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
