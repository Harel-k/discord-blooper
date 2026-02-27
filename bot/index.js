require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder
} = require("discord.js");

// ==============================
// Config / Paths
// ==============================
const DATA_DIR = path.join(__dirname, "data");
const GUILDS_STATE_PATH = path.join(DATA_DIR, "guild_state.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(GUILDS_STATE_PATH)) fs.writeFileSync(GUILDS_STATE_PATH, JSON.stringify({}, null, 2));
}

function readGuildState() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(GUILDS_STATE_PATH, "utf8"));
}

function writeGuildState(state) {
  ensureDataDir();
  fs.writeFileSync(GUILDS_STATE_PATH, JSON.stringify(state, null, 2));
}

function loadTemplate(templateId) {
  const filePath = path.join(__dirname, "templates", `${templateId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ==============================
// Permission Packs (Safe MVP)
// ==============================
const PERM_PACKS = {
  owner: [PermissionsBitField.Flags.Administrator],
  admin: [
    PermissionsBitField.Flags.ManageGuild,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.ModerateMembers,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ViewAuditLog
  ],
  mod: [
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.ModerateMembers,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ViewAuditLog
  ],
  helper: [PermissionsBitField.Flags.ManageMessages],
  verified: [],
  member: [],
  ping: []
};

function permsForPack(packName) {
  return PERM_PACKS[packName] ?? [];
}

// ==============================
// Slash Commands
// ==============================
const commands = [
  new SlashCommandBuilder()
    .setName("build")
    .setDescription("Build a server from a template")
    .addStringOption(opt =>
      opt
        .setName("template")
        .setDescription("Template id (default: roblox_standard_v1)")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Edit server with natural text (MVP)")
    .addStringOption(opt =>
      opt
        .setName("command")
        .setDescription('Example: "change role Admin color to black"')
        .setRequired(true)
    )
].map(c => c.toJSON());

// ==============================
// Register commands globally
// (Might take a bit to appear. For fast dev, you can switch to guild commands.)
// ==============================
async function registerCommands() {
  const token = process.env.BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) throw new Error("Missing BOT_TOKEN or CLIENT_ID in .env");

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("✅ Slash commands registered (global).");
}

// ==============================
// Helpers
// ==============================
function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    return false;
  }
  return true;
}

function normalizeColor(input) {
  // Accept: black, white, red, #000000, 000000
  const named = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#00ff00",
    blue: "#0000ff",
    yellow: "#ffff00",
    orange: "#ffa500",
    purple: "#800080",
    pink: "#ff69b4",
    cyan: "#00ffff",
    gray: "#808080",
    grey: "#808080"
  };

  const s = String(input || "").trim().toLowerCase();

  if (named[s]) return named[s];

  if (s.startsWith("#") && s.length === 7) return s;
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`;
  return null;
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp({ content, ephemeral: true });
    return await interaction.reply({ content, ephemeral: true });
  } catch {
    // ignore
  }
}

// ==============================
// Build Engine
// ==============================
async function buildFromTemplate(guild, templateId) {
  const template = loadTemplate(templateId);
  const state = readGuildState();
  state[guild.id] = state[guild.id] || { roles: {}, categories: {}, channels: {} };

  // 1) Create roles (create from lowest -> highest so hierarchy reordering is easier)
  // We'll create in template order but later reorder.
  for (const r of template.roles) {
    const perms = permsForPack(r.permPack);
    const created = await guild.roles.create({
      name: r.name,
      color: r.color,
      hoist: !!r.hoist,
      mentionable: !!r.mentionable,
      permissions: perms
    });
    state[guild.id].roles[r.key] = created.id;
  }

  // 1b) Reorder roles according to template order (Owner highest at top)
  // Discord role positions: higher number = higher role
  // We set positions by editing multiple roles. This is "best effort".
  try {
    const positions = [];
    // Put template roles above most roles, but below bot’s top role automatically
    // We'll set relative positions in order.
    const templateRoleIds = template.roles
      .map(r => state[guild.id].roles[r.key])
      .filter(Boolean);

    // Sort roles by current position and then map new positions
    // We'll just set a descending ladder.
    let base = guild.roles.highest.position - 1;
    for (const roleId of templateRoleIds) {
      positions.push({ id: roleId, position: base });
      base -= 1;
    }
    await guild.roles.setPositions(positions);
  } catch (e) {
    // Not fatal; role hierarchy can be manually adjusted
  }

  // Helpers for overwrite conversion
  const getRoleIdByKey = (roleKey) => state[guild.id].roles[roleKey];
  const EVERYONE_ID = guild.roles.everyone.id;

  function convertOverwrite(ow) {
    let id = null;
    if (ow.target === "@everyone") id = EVERYONE_ID;
    if (ow.targetRoleKey) id = getRoleIdByKey(ow.targetRoleKey);
    if (!id) return null;

    // Map permission names to bitfields via PermissionsBitField.Flags
    const allow = (ow.allow || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
    const deny = (ow.deny || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);

    return { id, allow, deny };
  }

  // 2) Create categories + channels
  for (const cat of template.categories) {
    const overwrites = (cat.overwrites || [])
      .map(convertOverwrite)
      .filter(Boolean);

    const category = await guild.channels.create({
      name: cat.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites
    });

    state[guild.id].categories[cat.key] = category.id;

    for (const ch of cat.channels) {
      const channel = await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: ch.topic || null,
        rateLimitPerUser: Math.max(0, Number(ch.slowmode || 0))
      });

      state[guild.id].channels[ch.key] = channel.id;
    }
  }

  // 3) Post starter messages
  for (const msg of template.messages || []) {
    const channelId = state[guild.id].channels[msg.channelKey];
    if (!channelId) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    if (msg.type === "embed") {
      const embed = new EmbedBuilder()
        .setTitle(msg.title || "Message")
        .setDescription(msg.description || "");
      await channel.send({ embeds: [embed] });
    } else if (msg.type === "text") {
      await channel.send({ content: msg.content || "" });
    }
  }

  writeGuildState(state);
  return template;
}

// ==============================
// Edit Engine (MVP parser)
// Supports:
// - "change role <name> color to <color>"
// - "rename channel <old> to <new>"
// - "rename category <old> to <new>"
// - "create channel <name> in category <category>"
// - "lock channel <name>" / "unlock channel <name>"
// ==============================
async function runEditCommand(guild, rawText) {
  const text = rawText.trim();

  // change role Admin color to black
  {
    const m = text.match(/^change\s+role\s+(.+?)\s+color\s+to\s+(.+)$/i);
    if (m) {
      const roleName = m[1].trim();
      const colorStr = m[2].trim();
      const color = normalizeColor(colorStr);
      if (!color) return { ok: false, message: `Unknown color: "${colorStr}". Try #000000 or "black".` };

      const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) return { ok: false, message: `Role not found: "${roleName}"` };

      // Bot must be higher than the role
      const me = guild.members.me;
      if (me && role.position >= me.roles.highest.position) {
        return { ok: false, message: `I can't edit that role because it's higher/equal to my top role.` };
      }

      await role.setColor(color);
      return { ok: true, message: `✅ Changed role **${role.name}** color to **${color}**.` };
    }
  }

  // rename channel old to new
  {
    const m = text.match(/^rename\s+channel\s+(.+?)\s+to\s+(.+)$/i);
    if (m) {
      const oldName = m[1].trim();
      const newName = m[2].trim().replace(/\s+/g, "-").toLowerCase();

      const channel = guild.channels.cache.find(
        c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === oldName.toLowerCase()
      );
      if (!channel) return { ok: false, message: `Channel not found: "${oldName}"` };

      await channel.setName(newName);
      return { ok: true, message: `✅ Renamed channel to **${newName}**.` };
    }
  }

  // rename category old to new
  {
    const m = text.match(/^rename\s+category\s+(.+?)\s+to\s+(.+)$/i);
    if (m) {
      const oldName = m[1].trim();
      const newName = m[2].trim();

      const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === oldName.toLowerCase());
      if (!category) return { ok: false, message: `Category not found: "${oldName}"` };

      await category.setName(newName);
      return { ok: true, message: `✅ Renamed category to **${newName}**.` };
    }
  }

  // create channel <name> in category <category>
  {
    const m = text.match(/^create\s+channel\s+(.+?)\s+in\s+category\s+(.+)$/i);
    if (m) {
      const chanName = m[1].trim().replace(/\s+/g, "-").toLowerCase();
      const catName = m[2].trim();

      const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === catName.toLowerCase());
      if (!category) return { ok: false, message: `Category not found: "${catName}"` };

      const created = await guild.channels.create({
        name: chanName,
        type: ChannelType.GuildText,
        parent: category.id
      });

      return { ok: true, message: `✅ Created channel **#${created.name}** in **${category.name}**.` };
    }
  }

  // lock/unlock channel <name>
  {
    const m = text.match(/^(lock|unlock)\s+channel\s+(.+)$/i);
    if (m) {
      const mode = m[1].toLowerCase();
      const chanName = m[2].trim();

      const channel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name.toLowerCase() === chanName.toLowerCase()
      );
      if (!channel) return { ok: false, message: `Channel not found: "${chanName}"` };

      const everyoneId = guild.roles.everyone.id;

      if (mode === "lock") {
        await channel.permissionOverwrites.edit(everyoneId, { SendMessages: false });
        return { ok: true, message: `🔒 Locked **#${channel.name}** (everyone can't send).` };
      } else {
        await channel.permissionOverwrites.edit(everyoneId, { SendMessages: null });
        return { ok: true, message: `🔓 Unlocked **#${channel.name}**.` };
      }
    }
  }

  return {
    ok: false,
    message:
      `I didn't understand. Try:\n` +
      `• change role Admin color to black\n` +
      `• rename channel chat to general\n` +
      `• rename category 📌 INFO to INFO\n` +
      `• create channel trading in category 💬 COMMUNITY\n` +
      `• lock channel announcements`
  };
}

// ==============================
// Client
// ==============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Admin-only for MVP
  if (!requireAdmin(interaction)) {
    return safeReply(interaction, "❌ You need **Administrator** to use this.");
  }

  if (!interaction.guild) {
    return safeReply(interaction, "❌ This must be used in a server.");
  }

  if (interaction.commandName === "build") {
    const templateId = interaction.options.getString("template") || "roblox_standard_v1";
    await interaction.reply({ content: `🏗️ Building template **${templateId}**...`, ephemeral: true });

    try {
      const template = await buildFromTemplate(interaction.guild, templateId);
      await interaction.followUp({ content: `✅ Build complete: **${template.name}**`, ephemeral: true });
    } catch (e) {
      await interaction.followUp({ content: `❌ Build failed: ${e.message}`, ephemeral: true });
    }
  }

  if (interaction.commandName === "edit") {
    const cmd = interaction.options.getString("command");
    await interaction.reply({ content: `🧠 Running edit: "${cmd}"`, ephemeral: true });

    try {
      const result = await runEditCommand(interaction.guild, cmd);
      await interaction.followUp({ content: result.message, ephemeral: true });
    } catch (e) {
      await interaction.followUp({ content: `❌ Edit failed: ${e.message}`, ephemeral: true });
    }
  }
});

// ==============================
// Start
// ==============================
(async () => {
  try {
    await registerCommands();
    await client.login(process.env.BOT_TOKEN);
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();