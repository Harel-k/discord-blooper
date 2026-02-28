require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 5050;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3"; // change to mistral if you want
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";

// ==========================
// Template Pack (local "web-like" knowledge)
// ==========================
const TEMPLATE_PACK = {
  // We keep this short but strong. The model can expand/customize.
  requiredCategories: [
    { key: "info", name: "📌 INFO", mustHaveChannels: ["welcome", "rules", "announcements"] },
    { key: "community", name: "💬 COMMUNITY", mustHaveChannels: ["general", "media", "memes", "suggestions"] },
    { key: "support", name: "🆘 SUPPORT", mustHaveChannels: ["help", "tickets"] },
    { key: "bots", name: "🤖 BOTS", mustHaveChannels: ["bot-commands", "bot-logs"] },
    { key: "staff", name: "🛡️ STAFF", mustHaveChannels: ["staff-chat", "mod-logs"] },
    { key: "voice", name: "🔊 VOICE", mustHaveChannels: ["General VC", "AFK"] }
  ],
  requiredRoles: [
    { key: "owner", name: "Owner", permPack: "owner" },
    { key: "admin", name: "Admin", permPack: "admin" },
    { key: "mod", name: "Moderator", permPack: "mod" },
    { key: "helper", name: "Helper", permPack: "helper" },
    { key: "member", name: "Member", permPack: "member" },
    { key: "verified", name: "Verified", permPack: "verified" },
    { key: "bots", name: "Bots", permPack: "member" }
  ],
  pingRoles: [
    { key: "ping_giveaways", name: "Giveaways Ping", permPack: "ping" },
    { key: "ping_events", name: "Events Ping", permPack: "ping" }
  ]
};

// ==========================
// Ollama Call (safe)
// ==========================
async function callOllama(systemPrompt, userPrompt) {
  const r = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `${systemPrompt}\n\nUSER PROMPT:\n${userPrompt}`,
      stream: false
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Ollama HTTP error: " + text);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Ollama returned non-JSON: " + text); }

  if (!data || typeof data.response !== "string") {
    console.log("DEBUG OLLAMA RAW:", data);
    throw new Error("Ollama returned invalid response (missing response string)");
  }

  return data.response;
}

// ==========================
// JSON extraction (safe)
// ==========================
function extractJSON(rawText) {
  if (!rawText || typeof rawText !== "string") throw new Error("Model returned empty response");

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.log("MODEL OUTPUT (no JSON):", rawText);
    throw new Error("Model did not return JSON");
  }

  const jsonString = rawText.substring(start, end + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.log("MODEL OUTPUT (bad JSON):", rawText);
    throw new Error("Failed to parse model JSON");
  }
}

// ==========================
// Normalizers / defaults
// ==========================
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

function ensureDefaults(bp) {
  bp.name = String(bp.name || "Advanced Server").slice(0, 80);
  bp.language = ["EN", "HE", "EN+HE"].includes(bp.language) ? bp.language : "EN";
  bp.theme = String(bp.theme || "community").slice(0, 80);

  bp.roles = Array.isArray(bp.roles) ? bp.roles : [];
  bp.categories = Array.isArray(bp.categories) ? bp.categories : [];
  bp.messages = Array.isArray(bp.messages) ? bp.messages : [];

  // roles
  bp.roles = bp.roles.map((r, i) => ({
    key: String(r.key || `role_${i}`),
    name: String(r.name || `Role ${i}`),
    color: String(r.color || "#95a5a6"),
    permPack: ["owner","admin","mod","helper","verified","member","ping"].includes(r.permPack) ? r.permPack : "member",
    hoist: typeof r.hoist === "boolean" ? r.hoist : false,
    mentionable: typeof r.mentionable === "boolean" ? r.mentionable : false
  }));

  // categories + channels
  bp.categories = bp.categories.map((c, i) => {
    const cat = {
      key: String(c.key || `cat_${i}`),
      name: String(c.name || `Category ${i}`),
      overwrites: Array.isArray(c.overwrites) ? c.overwrites : [],
      channels: Array.isArray(c.channels) ? c.channels : []
    };

    cat.channels = cat.channels.map((ch, j) => ({
      type: ch.type === "voice" ? "voice" : "text",
      key: String(ch.key || `ch_${i}_${j}`),
      name: ch.type === "voice" ? String(ch.name || `Voice ${j}`) : normalizeChannelName(ch.name || `channel-${j}`),
      topic: String(ch.topic || ""),
      slowmode: Number.isFinite(Number(ch.slowmode)) ? Number(ch.slowmode) : 0
    }));

    return cat;
  });

  // messages
  bp.messages = bp.messages.map((m) => ({
    channelKey: String(m.channelKey || ""),
    type: m.type === "text" ? "text" : "embed",
    title: String(m.title || ""),
    description: String(m.description || ""),
    content: String(m.content || "")
  }));

  return bp;
}

// ==========================
// Advanced validation + auto expand
// ==========================
function countChannels(bp) {
  return bp.categories.reduce((sum, c) => sum + (c.channels?.length || 0), 0);
}

function hasGeneralChat(bp) {
  // must include a text channel named "general" or "general-chat"
  for (const c of bp.categories) {
    for (const ch of c.channels || []) {
      if (ch.type === "text" && (ch.name === "general" || ch.name === "general-chat")) return true;
    }
  }
  return false;
}

function validateBlueprint(bp) {
  const errors = [];

  const roleCount = bp.roles.length;
  const channelCount = countChannels(bp);

  if (roleCount < 6) errors.push(`Too few roles (${roleCount}). Need >= 6.`);
  if (bp.categories.length < 4) errors.push(`Too few categories (${bp.categories.length}). Need >= 4.`);
  if (channelCount < 10) errors.push(`Too few channels (${channelCount}). Need >= 10.`);
  if (!hasGeneralChat(bp)) errors.push(`Missing general chat channel (general or general-chat).`);

  return errors;
}

function mergeRequiredSkeleton(bp) {
  // Ensure baseline structure exists. Model can add more.
  const roleKeys = new Set(bp.roles.map(r => r.key));
  for (const rr of TEMPLATE_PACK.requiredRoles) {
    if (!roleKeys.has(rr.key)) {
      bp.roles.push({
        key: rr.key,
        name: rr.name,
        color: rr.key === "owner" ? "#f1c40f" : rr.key === "admin" ? "#e74c3c" : rr.key === "mod" ? "#3498db" : "#95a5a6",
        permPack: rr.permPack,
        hoist: ["owner","admin","mod"].includes(rr.key),
        mentionable: false
      });
    }
  }
  // add ping roles too
  for (const pr of TEMPLATE_PACK.pingRoles) {
    if (!roleKeys.has(pr.key)) {
      bp.roles.push({
        key: pr.key,
        name: pr.name,
        color: pr.key.includes("give") ? "#1abc9c" : "#e67e22",
        permPack: "ping",
        hoist: false,
        mentionable: true
      });
    }
  }

  const catKeys = new Set(bp.categories.map(c => c.key));
  for (const rc of TEMPLATE_PACK.requiredCategories) {
    if (!catKeys.has(rc.key)) {
      bp.categories.push({ key: rc.key, name: rc.name, overwrites: [], channels: [] });
    }
  }

  // Ensure must-have channels exist in each required category
  for (const req of TEMPLATE_PACK.requiredCategories) {
    const cat = bp.categories.find(c => c.key === req.key);
    if (!cat) continue;

    const chNames = new Set((cat.channels || []).map(ch => ch.type === "voice" ? ch.name : ch.name));
    for (const want of req.mustHaveChannels) {
      if (chNames.has(want) || chNames.has(normalizeChannelName(want))) continue;

      if (req.key === "voice") {
        cat.channels.push({
          type: "voice",
          key: `vc_${normalizeChannelName(want)}`,
          name: want,
          topic: "",
          slowmode: 0
        });
      } else {
        const nm = want === "general" ? "general" : normalizeChannelName(want);
        cat.channels.push({
          type: "text",
          key: nm,
          name: nm,
          topic: "",
          slowmode: want === "general" ? 2 : 0
        });
      }
    }
  }

  // Staff category permissions (placeholder overwrites by roleKey)
  const staff = bp.categories.find(c => c.key === "staff");
  if (staff) {
    staff.overwrites = [
      { target: "@everyone", targetRoleKey: "", allow: [], deny: ["ViewChannel"] },
      { target: "", targetRoleKey: "helper", allow: ["ViewChannel","SendMessages","ReadMessageHistory"], deny: [] },
      { target: "", targetRoleKey: "mod", allow: ["ViewChannel","SendMessages","ReadMessageHistory"], deny: [] },
      { target: "", targetRoleKey: "admin", allow: ["ViewChannel","SendMessages","ReadMessageHistory"], deny: [] }
    ];
  }

  return bp;
}

async function generateAdvancedBlueprint(userPrompt) {
  const system = `
You generate an ADVANCED Discord server blueprint JSON for a server-maker bot.

Return ONLY valid JSON with this exact structure:

{
  "name": string,
  "language": "EN" | "HE" | "EN+HE",
  "theme": string,
  "roles": [
    { "key": string, "name": string, "color": "#RRGGBB", "permPack": "...", "hoist": boolean, "mentionable": boolean }
  ],
  "categories": [
    {
      "key": string,
      "name": string,
      "overwrites": [
        { "target": string, "targetRoleKey": string, "allow": [string], "deny": [string] }
      ],
      "channels": [
        { "type": "text" | "voice", "key": string, "name": string, "topic": string, "slowmode": number }
      ]
    }
  ],
  "messages": [
    { "channelKey": string, "type": "embed" | "text", "title": string, "description": string, "content": string }
  ]
}

HARD REQUIREMENTS:
- 6 to 12 roles
- 4 to 8 categories
- 10 to 25 total channels
- MUST include a text channel named "general" (or "general-chat")
- MUST include categories: info, community, support, staff, bots, voice
- staff category MUST be staff-only (use overwrites with target "@everyone" deny ViewChannel and allow for helper/mod/admin via targetRoleKey)
- channel names for text MUST be lowercase-with-dashes
- include 2-4 voice channels under "voice" category (General VC, Music, AFK etc.)

DEFAULTS IF UNSURE:
- topic = ""
- slowmode = 0
- overwrites = []
- messages = []

Only return JSON. No markdown. No explanation.
`;

  // First attempt
  const raw1 = await callOllama(system, userPrompt);
  let bp = ensureDefaults(extractJSON(raw1));
  bp = mergeRequiredSkeleton(bp);
  bp = ensureDefaults(bp);

  // Validate + up to 2 expansions
  for (let i = 0; i < 2; i++) {
    const errs = validateBlueprint(bp);
    if (errs.length === 0) return bp;

    const expandPrompt =
      `Your last JSON was missing requirements:\n- ${errs.join("\n- ")}\n\n` +
      `Please RETURN ONLY corrected JSON (same structure), EXPANDING the layout to meet ALL requirements.`;

    const rawX = await callOllama(system, userPrompt + "\n\n" + expandPrompt);
    bp = ensureDefaults(extractJSON(rawX));
    bp = mergeRequiredSkeleton(bp);
    bp = ensureDefaults(bp);
  }

  // Final return even if imperfect, but it should be good now
  return bp;
}

// ==========================
// Routes
// ==========================
app.get("/", (req, res) => res.json({ ok: true, ai: "ollama", model: OLLAMA_MODEL, port: PORT }));

app.post("/ai/blueprint", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  try {
    const blueprint = await generateAdvancedBlueprint(prompt);
    return res.json({ blueprint });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/ai/edits", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const system = `
Convert user edit request into JSON:

{
  "actions": [
    {
      "action": "edit_role_color" | "rename_role" | "rename_channel" | "rename_category" | "create_channel" | "lock_channel" | "unlock_channel" | "set_slowmode",
      "roleName": "",
      "channelName": "",
      "categoryName": "",
      "newName": "",
      "color": "",
      "createChannelName": "",
      "inCategoryName": "",
      "slowmode": 0
    }
  ]
}

Return JSON only. If unsure return {"actions":[]}.
`;

  try {
    const raw = await callOllama(system, prompt);
    const edits = extractJSON(raw);
    edits.actions = Array.isArray(edits.actions) ? edits.actions : [];
    return res.json({ edits });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Local Ollama AI API running on http://localhost:${PORT}`));