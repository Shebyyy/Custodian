// @ts-nocheck — discord.js type quirks with bun
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Client, CommandInteraction, Interaction,
  MessageComponentInteraction, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, EmbedBuilder,
} from "discord.js";
import { getConfig, saveConfig, saveGuildId, BotConfig } from "../config.js";

/**
 * /setup — In-Discord setup wizard
 * Walks admin through configuration using Discord native dropdowns & buttons.
 */
interface SetupState {
  step: "start" | "roles" | "channels" | "backup" | "quiz" | "done";
  guildId: string;
  roles: { unverified: string; verified: string; admin: string };
  channels: { welcome: string; rules: string; verification: string };
  backupChannels: string[];
  quizQuestions: { id: number; question: string; type: string; options: string[]; correctAnswer: string }[];
}

const activeSetups = new Map<string, SetupState>();

const MAX_SELECT_OPTIONS = 24; // Discord max is 25, leave 1 for "Done"

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function getSetupCommands() {
  return [
    {
      name: "setup" as const,
      description: "Start the Custodian setup wizard (admin only)",
    },
  ];
}

export async function handleSetupCommand(interaction: CommandInteraction, client: Client): Promise<void> {
  const config = getConfig();

  // Check if admin
  if (config.guildId) {
    try {
      const member = await interaction.guild?.members.fetch(interaction.user.id);
      if (member && config.roles.admin && !member.roles.cache.has(config.roles.admin)) {
        await interaction.reply({ content: "❌ Only admins can run /setup", ephemeral: true });
        return;
      }
    } catch {}
  }

  // Find the guild
  const guilds = client.guilds.cache;
  if (!guilds.size) {
    await interaction.reply({ content: "❌ I'm not in any server! Invite me first.", ephemeral: true });
    return;
  }

  const guild = guilds.first()!;
  const state: SetupState = {
    step: "roles",
    guildId: guild.id,
    roles: { unverified: config.roles?.unverified || "", verified: config.roles?.verified || "", admin: config.roles?.admin || "" },
    channels: { welcome: config.channels?.welcome || "", rules: config.channels?.rules || "", verification: config.channels?.verification || "" },
    backupChannels: config.backupChannels || [],
    quizQuestions: config.quiz?.questions?.length ? config.quiz.questions : [
      { id: 1, question: "Is it okay to spam?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
      { id: 2, question: "Be respectful to everyone?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "Yes" },
      { id: 3, question: "NSFW allowed?", type: "yes_no", options: ["Yes", "No"], correctAnswer: "No" },
    ],
  };

  activeSetups.set(interaction.user.id, state);
  saveGuildId(guild.id);
  state.guildId = guild.id;

  try {
    await interaction.reply({
      content: `🔧 **Custodian Setup Wizard**\n\nServer: **${truncate(guild.name, 50)}** (${guild.memberCount} members)\n\n**Step 1/4: Select Roles**\nPick which role to configure:`,
      ephemeral: true,
      components: [buildRoleSelect(state)],
    });
  } catch (err: any) {
    console.error("Setup error:", err);
    try {
      await interaction.reply({ content: `❌ Setup failed: ${err.message || err}`, ephemeral: true });
    } catch {}
  }
}

export async function handleSetupInteraction(interaction: Interaction, client: Client): Promise<boolean> {
  if (!interaction.isMessageComponent()) return false;
  if (!interaction.customId.startsWith("setup_")) return false;

  try {
    const state = activeSetups.get(interaction.user.id);
    if (!state) {
      await interaction.reply({ content: "❌ No active setup. Run /setup again.", ephemeral: true });
      return true;
    }

    const guild = client.guilds.cache.get(state.guildId)!;

    if (interaction.customId === "setup_role_select" && interaction.isStringSelectMenu()) {
      return await handleRoleSelect(interaction, state, guild) || true;
    }

    if (interaction.customId === "setup_channel_select" && interaction.isStringSelectMenu()) {
      return await handleChannelSelect(interaction, state, guild) || true;
    }

    if (interaction.customId === "setup_backup_toggle" && interaction.isStringSelectMenu()) {
      return await handleBackupToggle(interaction, state) || true;
    }

    if (interaction.customId === "setup_skip_backup" && interaction.isButton()) {
      state.step = "quiz";
      await interaction.update({ content: buildQuizStep(state), components: [buildQuizButtons()] });
      return true;
    }

    if (interaction.customId === "setup_done_backup" && interaction.isButton()) {
      state.step = "quiz";
      await interaction.update({ content: buildQuizStep(state), components: [buildQuizButtons()] });
      return true;
    }

    if (interaction.customId === "setup_skip_quiz" && interaction.isButton()) {
      await saveAndFinish(interaction, state);
      return true;
    }

    if (interaction.customId === "setup_done_quiz" && interaction.isButton()) {
      await saveAndFinish(interaction, state);
      return true;
    }
  } catch (err: any) {
    console.error("Setup interaction error:", err);
    try {
      await interaction.reply({ content: `❌ Error: ${truncate(err.message || String(err), 200)}`, ephemeral: true });
    } catch {}
    return true;
  }

  return false;
}

// ─── Role Selection ───
function buildRoleSelect(state: SetupState) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup_role_select")
      .setPlaceholder("Select a role to assign...")
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel("Set UNVERIFIED role")
          .setValue("label:unverified")
          .setDescription(truncate(state.roles.unverified ? "✅ Set" : "Not set", 100))
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Set VERIFIED role")
          .setValue("label:verified")
          .setDescription(truncate(state.roles.verified ? "✅ Set" : "Not set", 100))
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Set ADMIN role")
          .setValue("label:admin")
          .setDescription(truncate(state.roles.admin ? "✅ Set" : "Not set", 100))
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Done -> Channels")
          .setValue("done")
          .setDescription("Continue to next step")
        ,
      ])
  );
}

function getRoleOptions(guild: any, roleType: string) {
  const roles = guild.roles.cache.filter((r: any) => !r.managed && r.name !== "@everyone").sort((a: any, b: any) => b.position - a.position);
  return [...roles.values()]
    .slice(0, MAX_SELECT_OPTIONS)
    .map((r: any) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(truncate(r.name, 100))
        .setValue(`${roleType}:${r.id}`)
        .setDescription(truncate(`Position: ${r.position}`, 100))
    );
}

async function handleRoleSelect(interaction: any, state: SetupState, guild: any) {
  const value = interaction.values[0];

  if (value.startsWith("label:")) {
    const roleType = value.split(":")[1];
    const options = getRoleOptions(guild, roleType);

    if (!options.length) {
      await interaction.reply({ content: `⚠️ No roles found. Create roles first in Server Settings.`, ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Select the **${roleType.toUpperCase()}** role:`,
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("setup_role_select")
            .setPlaceholder(`Select ${roleType} role...`)
            .addOptions(options)
        ),
      ],
    });
    return;
  }

  if (value === "done") {
    if (!state.roles.unverified || !state.roles.verified || !state.roles.admin) {
      await interaction.reply({ content: "⚠️ Please set all 3 roles before continuing.", ephemeral: true });
      return;
    }
    state.step = "channels";
    const unv = guild.roles.cache.get(state.roles.unverified)?.name || "?";
    const ver = guild.roles.cache.get(state.roles.verified)?.name || "?";
    const adm = guild.roles.cache.get(state.roles.admin)?.name || "?";
    await interaction.update({
      content: `**Step 2/4: Select Channels**\n\n🔴 Unverified: ${unv}\n🟢 Verified: ${ver}\n🛡️ Admin: ${adm}\n\nPick which channel to configure:`,
      components: [buildChannelSelect(state)],
    });
    return;
  }

  const [roleType, roleId] = value.split(":");
  (state.roles as any)[roleType] = roleId;
  const roleName = guild.roles.cache.get(roleId)?.name || roleId;
  await interaction.update({
    content: `🔧 **Step 1/4: Select Roles**\n\n🔴 Unverified: ${guild.roles.cache.get(state.roles.unverified)?.name || "❌ not set"}\n🟢 Verified: ${guild.roles.cache.get(state.roles.verified)?.name || "❌ not set"}\n🛡️ Admin: ${guild.roles.cache.get(state.roles.admin)?.name || "❌ not set"}`,
    components: [buildRoleSelect(state)],
  });
}

// ─── Channel Selection ───
function buildChannelSelect(state: SetupState) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup_channel_select")
      .setPlaceholder("Assign a channel...")
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel("Set WELCOME channel")
          .setValue("label:welcome")
          .setDescription(state.channels.welcome ? "✅ Set" : "Not set")
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Set RULES channel")
          .setValue("label:rules")
          .setDescription(state.channels.rules ? "✅ Set" : "Not set")
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Set VERIFICATION channel")
          .setValue("label:verification")
          .setDescription(state.channels.verification ? "✅ Set" : "Not set")
        ,
        new StringSelectMenuOptionBuilder()
          .setLabel("Done -> Backup")
          .setValue("done")
          .setDescription("Continue to next step")
        ,
      ])
  );
}

function getChannelOptions(guild: any, chType: string) {
  const channels = guild.channels.cache
    .filter((c: any) => c.type === ChannelType.GuildText)
    .sorted((a: any, b: any) => a.position - b.position);
  return [...channels.values()]
    .slice(0, MAX_SELECT_OPTIONS)
    .map((c: any) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(truncate(`#${c.name}`, 100))
        .setValue(`${chType}:${c.id}`)
    );
}

async function handleChannelSelect(interaction: any, state: SetupState, guild: any) {
  const value = interaction.values[0];

  if (value.startsWith("label:")) {
    const chType = value.split(":")[1];
    const options = getChannelOptions(guild, chType);

    if (!options.length) {
      await interaction.reply({ content: "⚠️ No text channels found.", ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Select the **${chType.toUpperCase()}** channel:`,
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("setup_channel_select")
            .setPlaceholder(`Select ${chType} channel...`)
            .addOptions(options)
        ),
      ],
    });
    return;
  }

  if (value === "done") {
    if (!state.channels.welcome || !state.channels.rules || !state.channels.verification) {
      await interaction.reply({ content: "⚠️ Please set all 3 channels before continuing.", ephemeral: true });
      return;
    }
    state.step = "backup";
    await interaction.update({
      content: `**Step 3/4: Backup Channels (optional)**\n\nWelcome: <#${state.channels.welcome}>\nRules: <#${state.channels.rules}>\nVerification: <#${state.channels.verification}>\n\nThis step is optional. Skip if you don't need channel backups.`,
      components: [buildBackupSelect()],
    });
    return;
  }

  const [chType, chId] = value.split(":");
  (state.channels as any)[chType] = chId;
  await interaction.update({
    content: `**Step 2/4: Select Channels**\n\n👋 Welcome: ${state.channels.welcome ? `<#${state.channels.welcome}>` : "❌ not set"}\n📜 Rules: ${state.channels.rules ? `<#${state.channels.rules}>` : "❌ not set"}\n✅ Verification: ${state.channels.verification ? `<#${state.channels.verification}>` : "❌ not set"}`,
    components: [buildChannelSelect(state)],
  });
}

// ─── Backup Channel Selection ───
function buildBackupSelect() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("setup_done_backup").setLabel("✅ Done").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("setup_skip_backup").setLabel("⏭️ Skip").setStyle(ButtonStyle.Secondary),
  );
}

async function handleBackupToggle(interaction: any, state: SetupState) {
  // Backup toggle not using dropdown anymore — just skip/done buttons
  await interaction.reply({ content: "Use the Done or Skip buttons below.", ephemeral: true });
}

// ─── Quiz Step ───
function buildQuizStep(state: SetupState): string {
  const qList = state.quizQuestions.slice(0, 10).map((q, i) => `**${i + 1}.** ${q.question} → ✅ ${q.correctAnswer}`).join("\n");
  return `**Step 4/4: Quiz Questions** (${state.quizQuestions.length})\n\n${qList}\n\n_You can edit these later in config/bot.config.json_`;
}

function buildQuizButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("setup_done_quiz").setLabel("✅ Save & Finish").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("setup_skip_quiz").setLabel("Use defaults & finish").setStyle(ButtonStyle.Secondary),
  );
}

// ─── Save & Finish ───
async function saveAndFinish(interaction: MessageComponentInteraction, state: SetupState) {
  saveConfig({
    guildId: state.guildId,
    roles: state.roles,
    channels: state.channels,
    backupChannels: state.backupChannels,
    quiz: { maxAttempts: 3, passPercentage: 80, questions: state.quizQuestions },
    termsAndConditions: "## Server Rules\n\n1. Be respectful to all members.\n2. No spam, self-promotion, or unsolicited DMs.\n3. No NSFW or offensive content.\n4. Follow Discord's Terms of Service.\n5. Listen to staff — their decisions are final.\n6. Use channels for their intended purpose.\n\n**Breaking these rules may result in warnings, kicks, or bans.**",
  });

  activeSetups.delete(interaction.user.id);

  await interaction.update({
    content: `🎉 **Custodian Setup Complete!**\n\n**Roles:**\n🔴 Unverified: <@&${state.roles.unverified}>\n🟢 Verified: <@&${state.roles.verified}>\n🛡️ Admin: <@&${state.roles.admin}>\n\n**Channels:**\n👋 Welcome: <#${state.channels.welcome}>\n📜 Rules: <#${state.channels.rules}>\n✅ Verification: <#${state.channels.verification}>\n📦 Backup: ${state.backupChannels.length} channel(s)\n📝 Quiz: ${state.quizQuestions.length} questions\n\n_Saved to config/bot.config.json_`,
    components: [],
  });
}
