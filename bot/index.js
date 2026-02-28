require("dotenv").config();
const fs = require("fs");
const path = require("path");

// Node 18+ has fetch built-in. If you get "fetch is not defined", run: npm i node-fetch@2
// and uncomment the next line:
// const fetch = require("node-fetch");

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
const STATE_FILE = path.join(DATA_DIR, "guild_state.json");
const API_BASE = process.env.API_BASE || "http://localhost:5050";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({}, null, 2));
}
function readState() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function writeState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

// ==============================
// Helpers
// ==============================
function requireAdmin(interaction) {
  const member = interaction.member;
  return !!member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp({ content, ephemeral: true });
    }
    return await interaction.reply({ content, ephemeral: true });
  } catch {
    // ignore
  }
}

async function apiPost(endpoint, body) {
  const r = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `API error ${r.status}`);
  return data;
}

function normalizeChannelName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/\-+/g, "-")
    .replace(/^\-|\-$/g, "")
    .slice(0, 90);
}

// ==============================
// Build Engine (Blueprint JSON)
// ==============================
async function buildFromBlueprint(guild, blueprint) {
  const state = readState();
  state[guild.id] = state[guild.id] || { roles: {}, categories: {}, channels: {} };

  // Create roles
  for (const r of blueprint.roles) {
    const created = await guild.roles.create({
      name: r.name,
      color: r.color,
      hoist: !!r.hoist,
      mentionable: !!r.mentionable,
      permissions: PERM_PACKS[r.permPack] || []
    });
    state[guild.id].roles[r.key] = created.id;
  }

  // Best-effort reorder (puts first roles higher)
  try {
    const roleIds = blueprint.roles
      .map(r => state[guild.id].roles[r.key])
      .filter(Boolean);

    let base = guild.roles.highest.position - 1;
    const positions = roleIds.map(id => ({ id, position: base-- }));
    await guild.roles.setPositions(positions);
  } catch {
    // not fatal
  }

  const EVERYONE_ID = guild.roles.everyone.id;

  const getRoleIdByKey = (key) => state[guild.id].roles[key];

  function convertOverwrite(ow) {
    let id = null;
    if (ow.target === "@everyone") id = EVERYONE_ID;
    if (ow.targetRoleKey) id = getRoleIdByKey(ow.targetRoleKey);
    if (!id) return null;

    const allow = (ow.allow || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
    const deny  = (ow.deny  || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
    return { id, allow, deny };
  }

  // Create categories + channels
  for (const cat of blueprint.categories) {
    const overwrites = (cat.overwrites || []).map(convertOverwrite).filter(Boolean);

    const category = await guild.channels.create({
      name: cat.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites
    });

    state[guild.id].categories[cat.key] = category.id;

    for (const ch of cat.channels) {
      const channel = await guild.channels.create({
        name: normalizeChannelName(ch.name),
        type: ChannelType.GuildText,
        parent: category.id,
        topic: ch.topic || null,
        rateLimitPerUser: Math.max(0, Number(ch.slowmode || 0))
      });

      state[guild.id].channels[ch.key] = channel.id;
    }
  }

  // Starter messages
  for (const msg of blueprint.messages || []) {
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

  writeState(state);
}

// ==============================
// Edit Engine (Actions JSON)
// ==============================
function findRoleByName(guild, name) {
  const n = String(name || "").trim().toLowerCase();
  return guild.roles.cache.find(r => r.name.toLowerCase() === n) || null;
}
function findTextChannelByName(guild, name) {
  const n = normalizeChannelName(name);
  return guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === n) || null;
}
function findCategoryByName(guild, name) {
  const n = String(name || "").trim().toLowerCase();
  return guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === n) || null;
}

async function executeEdits(guild, edits) {
  const out = [];

  for (const a of edits.actions || []) {
    try {
      if (a.action === "edit_role_color") {
        const role = findRoleByName(guild, a.roleName);
        if (!role) { out.push(`❌ Role not found: ${a.roleName}`); continue; }

        const me = guild.members.me;
        if (me && role.position >= me.roles.highest.position) {
          out.push(`❌ Can't edit role (too high): ${role.name}`);
          continue;
        }

        await role.setColor(a.color);
        out.push(`✅ Role **${role.name}** color -> **${a.color}**`);
        continue;
      }

      if (a.action === "rename_role") {
        const role = findRoleByName(guild, a.roleName);
        if (!role) { out.push(`❌ Role not found: ${a.roleName}`); continue; }

        const me = guild.members.me;
        if (me && role.position >= me.roles.highest.position) {
          out.push(`❌ Can't rename role (too high): ${role.name}`);
          continue;
        }

        await role.setName(String(a.newName || "").trim().slice(0, 100));
        out.push(`✅ Role renamed to **${a.newName}**`);
        continue;
      }

      if (a.action === "rename_channel") {
        const channel = findTextChannelByName(guild, a.channelName);
        if (!channel) { out.push(`❌ Channel not found: ${a.channelName}`); continue; }

        const newName = normalizeChannelName(a.newName);
        await channel.setName(newName);
        out.push(`✅ Channel renamed -> **#${newName}**`);
        continue;
      }

      if (a.action === "rename_category") {
        const cat = findCategoryByName(guild, a.categoryName);
        if (!cat) { out.push(`❌ Category not found: ${a.categoryName}`); continue; }

        await cat.setName(String(a.newName || "").trim().slice(0, 100));
        out.push(`✅ Category renamed -> **${a.newName}**`);
        continue;
      }

      if (a.action === "create_channel") {
        const cat = findCategoryByName(guild, a.inCategoryName);
        if (!cat) { out.push(`❌ Category not found: ${a.inCategoryName}`); continue; }

        const name = normalizeChannelName(a.createChannelName);
        const created = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: cat.id
        });

        out.push(`✅ Created **#${created.name}** in **${cat.name}**`);
        continue;
      }

      if (a.action === "lock_channel" || a.action === "unlock_channel") {
        const channel = findTextChannelByName(guild, a.channelName);
        if (!channel) { out.push(`❌ Channel not found: ${a.channelName}`); continue; }

        const everyoneId = guild.roles.everyone.id;

        if (a.action === "lock_channel") {
          await channel.permissionOverwrites.edit(everyoneId, { SendMessages: false });
          out.push(`🔒 Locked **#${channel.name}**`);
        } else {
          await channel.permissionOverwrites.edit(everyoneId, { SendMessages: null });
          out.push(`🔓 Unlocked **#${channel.name}**`);
        }
        continue;
      }

      if (a.action === "set_slowmode") {
        const channel = findTextChannelByName(guild, a.channelName);
        if (!channel) { out.push(`❌ Channel not found: ${a.channelName}`); continue; }

        const seconds = Math.max(0, Number(a.slowmode || 0));
        await channel.setRateLimitPerUser(seconds);
        out.push(`⏱️ Slowmode **#${channel.name}** -> **${seconds}s**`);
        continue;
      }

      out.push(`⚠️ Unknown action: ${a.action}`);
    } catch (e) {
      out.push(`❌ ${a.action} failed: ${e.message}`);
    }
  }

  return out;
}

// ==============================
// Slash Commands (AI)
// ==============================
const commands = [
  new SlashCommandBuilder()
    .setName("buildprompt")
    .setDescription("AI: Build a server from your prompt")
    .addStringOption(o =>
      o.setName("prompt").setDescription("Describe the server you want").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("editprompt")
    .setDescription("AI: Edit the server from your prompt")
    .addStringOption(o =>
      o.setName("prompt").setDescription("Describe changes you want").setRequired(true)
    )
].map(c => c.toJSON());

async function registerCommands() {
  const token = process.env.BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) throw new Error("Missing BOT_TOKEN or CLIENT_ID in bot/.env");

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("✅ Slash commands registered (global).");
}

// ==============================
// Client
// ==============================
const bot = new Client({
  intents: [GatewayIntentBits.Guilds]
});

bot.once("ready", () => {
  console.log(`✅ Logged in as ${bot.user.tag}`);
});

bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guild) return safeReply(interaction, "❌ Use this in a server.");
  if (!requireAdmin(interaction)) return safeReply(interaction, "❌ You need Administrator.");

  if (interaction.commandName === "buildprompt") {
    const prompt = interaction.options.getString("prompt");
    await interaction.reply({ content: "🧠 AI is generating a blueprint...", ephemeral: true });

    try {
      const data = await apiPost("/ai/blueprint", { prompt });
      const blueprint = data.blueprint;

      await interaction.followUp({
        content: `🏗️ Building **${blueprint.name}** (${blueprint.language})...`,
        ephemeral: true
      });

      await buildFromBlueprint(interaction.guild, blueprint);

      await interaction.followUp({ content: "✅ AI build complete!", ephemeral: true });
    } catch (e) {
      await interaction.followUp({ content: `❌ Build failed: ${e.message}`, ephemeral: true });
    }
  }

  if (interaction.commandName === "editprompt") {
    const prompt = interaction.options.getString("prompt");
    await interaction.reply({ content: "🧠 AI is converting edits into actions...", ephemeral: true });

    try {
      const data = await apiPost("/ai/edits", { prompt });
      const edits = data.edits;

      const results = await executeEdits(interaction.guild, edits);
      await interaction.followUp({ content: results.join("\n").slice(0, 1900), ephemeral: true });
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
    await bot.login(process.env.BOT_TOKEN);
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();