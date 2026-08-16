import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  ChannelType, Client, CommandInteraction, Interaction,
  MessageComponentInteraction, ModalBuilder, StringSelectMenuInteraction,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder,
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
      { id: 1, question: "Is it okay to spam?", type: "yes_no" as const, options: ["Yes", "No"], correctAnswer: "No" },
      { id: 2, question: "Be respectful to everyone?", type: "yes_no" as const, options: ["Yes", "No"], correctAnswer: "Yes" },
      { id: 3, question: "NSFW allowed?", type: "yes_no" as const, options: ["Yes", "No"], correctAnswer: "No" },
    ],
  };

  activeSetups.set(interaction.user.id, state);

  // Save guild ID
  saveGuildId(guild.id);
  state.guildId = guild.id;

  await interaction.reply({
    content: `🔧 **Custodian Setup Wizard**\n\nServer: **${guild.name}** (${guild.memberCount} members)\n\nLet's configure your bot. I'll walk you through it step by step.\n\n**Step 1: Select Roles**`,
    ephemeral: true,
    components: [buildRoleSelect(guild, state)],
  });
}

export async function handleSetupInteraction(interaction: Interaction, client: Client): Promise<boolean> {
  if (!interaction.isMessageComponent()) return false;
  if (!interaction.customId.startsWith("setup_")) return false;

  const state = activeSetups.get(interaction.user.id);
  if (!state) {
    await interaction.reply({ content: "❌ No active setup. Run /setup again.", ephemeral: true });
    return true;
  }

  const guild = client.guilds.cache.get(state.guildId)!;

  if (interaction.customId === "setup_role_select" && interaction.isStringSelectMenu()) {
    handleRoleSelect(interaction, state, guild);
    return true;
  }

  if (interaction.customId === "setup_channel_select" && interaction.isStringSelectMenu()) {
    handleChannelSelect(interaction, state, guild);
    return true;
  }

  if (interaction.customId === "setup_backup_toggle" && interaction.isStringSelectMenu()) {
    handleBackupToggle(interaction, state, guild);
    return true;
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

  return false;
}

// ─── Role Selection ───
function buildRoleSelect(guild: any, state: SetupState) {
  const roles = guild.roles.cache.filter((r: any) => !r.managed && r.name !== "@everyone").sort((a: any, b: any) => b.position - a.position);

  const unverifiedOptions = roles.map((r: any) => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(`unverified:${r.id}`).setDescription(state.roles.unverified === r.id ? "✅ Selected" : ""));
  const verifiedOptions = roles.map((r: any) => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(`verified:${r.id}`).setDescription(state.roles.verified === r.id ? "✅ Selected" : ""));
  const adminOptions = roles.map((r: any) => new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(`admin:${r.id}`).setDescription(state.roles.admin === r.id ? "✅ Selected" : ""));

  return new ActionRowBuilder<StringSelectMenuBuilder>()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("setup_role_select")
        .setPlaceholder("Select a role to assign...")
        .addOptions([
          new StringSelectMenuOptionBuilder().setLabel("⬆️ Set UNVERIFIED role").setValue("label:unverified").setDescription(`Current: ${guild.roles.cache.get(state.roles.unverified)?.name || "none"}`).setEmoji("🔴"),
          new StringSelectMenuOptionBuilder().setLabel("✅ Set VERIFIED role").setValue("label:verified").setDescription(`Current: ${guild.roles.cache.get(state.roles.verified)?.name || "none"}`).setEmoji("🟢"),
          new StringSelectMenuOptionBuilder().setLabel("🛡️ Set ADMIN role").setValue("label:admin").setDescription(`Current: ${guild.roles.cache.get(state.roles.admin)?.name || "none"}`).setEmoji("🔵"),
          new StringSelectMenuOptionBuilder().setLabel("➡️ Done, continue to Channels").setValue("done").setEmoji("⏭️"),
        ])
    );
}

async function handleRoleSelect(interaction: any, state: SetupState, guild: any) {
  const value = interaction.values[0];

  if (value.startsWith("label:")) {
    const roleType = value.split(":")[1];
    const roles = guild.roles.cache.filter((r: any) => !r.managed && r.name !== "@everyone").sort((a: any, b: any) => b.position - a.position);
    const options = roles.map((r: any) =>
      new StringSelectMenuOptionBuilder().setLabel(r.name).setValue(`${roleType}:${r.id}`)
    );

    await interaction.reply({
      content: `Pick the **${roleType.toUpperCase()}** role:`,
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId("setup_role_select").setPlaceholder(`Select ${roleType} role...`).addOptions(options)
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
    await interaction.update({ content: `**Step 2: Select Channels**\n\nUnverified: <@&${state.roles.unverified}>\nVerified: <@&${state.roles.verified}>\nAdmin: <@&${state.roles.admin}>\n\nNow pick your channels:`, components: [buildChannelSelect(guild, state)] });
    return;
  }

  const [roleType, roleId] = value.split(":");
  (state.roles as any)[roleType] = roleId;
  const roleName = guild.roles.cache.get(roleId)?.name || roleId;
  await interaction.update({
    content: `🔧 **Step 1: Select Roles**\n\n🔴 Unverified: ${guild.roles.cache.get(state.roles.unverified)?.name || "❌ not set"}\n🟢 Verified: ${guild.roles.cache.get(state.roles.verified)?.name || "❌ not set"}\n🔵 Admin: ${guild.roles.cache.get(state.roles.admin)?.name || "❌ not set"}`,
    components: [buildRoleSelect(guild, state)],
  });
}

// ─── Channel Selection ───
function buildChannelSelect(guild: any, state: SetupState) {
  const channels = guild.channels.cache.filter((c: any) => c.type === ChannelType.GuildText).sorted((a: any, b: any) => a.position - b.position);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("setup_channel_select")
      .setPlaceholder("Assign a channel...")
      .addOptions([
        new StringSelectMenuOptionBuilder().setLabel("👋 Set WELCOME channel").setValue("label:welcome").setDescription(`Current: #${guild.channels.cache.get(state.channels.welcome)?.name || "none"}`),
        new StringSelectMenuOptionBuilder().setLabel("📜 Set RULES channel").setValue("label:rules").setDescription(`Current: #${guild.channels.cache.get(state.channels.rules)?.name || "none"}`),
        new StringSelectMenuOptionBuilder().setLabel("✅ Set VERIFICATION channel").setValue("label:verification").setDescription(`Current: #${guild.channels.cache.get(state.channels.verification)?.name || "none"}`),
        new StringSelectMenuOptionBuilder().setLabel("➡️ Done, continue").setValue("done").setEmoji("⏭️"),
      ])
  );
}

async function handleChannelSelect(interaction: any, state: SetupState, guild: any) {
  const value = interaction.values[0];

  if (value.startsWith("label:")) {
    const chType = value.split(":")[1];
    const channels = guild.channels.cache.filter((c: any) => c.type === ChannelType.GuildText).sorted((a: any, b: any) => a.position - b.position);
    const options = channels.map((c: any) => new StringSelectMenuOptionBuilder().setLabel(`#${c.name}`).setValue(`${chType}:${c.id}`));

    await interaction.reply({
      content: `Pick the **${chType.toUpperCase()}** channel:`,
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId("setup_channel_select").setPlaceholder(`Select ${chType} channel...`).addOptions(options)
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
      content: `**Step 3: Backup Channels (optional)**\n\nWelcome: <#${state.channels.welcome}>\nRules: <#${state.channels.rules}>\nVerification: <#${state.channels.verification}>\n\nWant to auto-backup any channels? Select below or skip.`,
      components: [buildBackupSelect(guild, state)],
    });
    return;
  }

  const [chType, chId] = value.split(":");
  (state.channels as any)[chType] = chId;
  await interaction.update({
    content: `**Step 2: Select Channels**\n\n👋 Welcome: <#${state.channels.welcome || "❌"}>\n📜 Rules: <#${state.channels.rules || "❌"}>\n✅ Verification: <#${state.channels.verification || "❌"}>`,
    components: [buildChannelSelect(guild, state)],
  });
}

// ─── Backup Channel Selection ───
function buildBackupSelect(guild: any, state: SetupState) {
  const channels = guild.channels.cache.filter((c: any) => c.type === ChannelType.GuildText).sorted((a: any, b: any) => a.position - b.position);
  const options = channels.map((c: any) => {
    const isSel = state.backupChannels.includes(c.id);
    return new StringSelectMenuOptionBuilder()
      .setLabel(`${isSel ? "✅ " : ""}#${c.name}`)
      .setValue(`backup:${c.id}`)
      .setDescription(isSel ? "Currently backed up" : "Click to toggle");
  });

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("setup_done_backup").setLabel("✅ Done").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("setup_skip_backup").setLabel("Skip").setStyle(ButtonStyle.Secondary),
  );
}

async function handleBackupToggle(interaction: any, state: SetupState, guild: any) {
  const chId = interaction.values[0].replace("backup:", "");
  if (state.backupChannels.includes(chId)) {
    state.backupChannels = state.backupChannels.filter((id) => id !== chId);
  } else {
    state.backupChannels.push(chId);
  }
  await interaction.reply({ content: state.backupChannels.length ? `📦 Now backing up ${state.backupChannels.length} channel(s)` : "📦 No backup channels selected", ephemeral: true });
}

// ─── Quiz Step ───
function buildQuizStep(state: SetupState): string {
  const qList = state.quizQuestions.map((q, i) => `**${i + 1}.** ${q.question} ✅ ${q.correctAnswer}`).join("\n");
  return `**Step 4: Quiz Questions** (${state.quizQuestions.length})\n\n${qList}\n\nYou can edit these later in config/bot.config.json.`;
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
    content: `🎉 **Custodian Setup Complete!**\n\n**Roles:**\n🔴 Unverified: <@&${state.roles.unverified}>\n🟢 Verified: <@&${state.roles.verified}>\n🛡️ Admin: <@&${state.roles.admin}>\n\n**Channels:**\n👋 Welcome: <#${state.channels.welcome}>\n📜 Rules: <#${state.channels.rules}>\n✅ Verification: <#${state.channels.verification}>\n📦 Backup: ${state.backupChannels.length} channel(s)\n📝 Quiz: ${state.quizQuestions.length} questions\n\nAll saved to config/bot.config.json`,
    components: [],
  });
}
