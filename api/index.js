require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 5050;

// -------------------------------
// Helpers
// -------------------------------
function getToolArgs(response, toolName) {
  // Responses API returns an "output" array of items (messages + tool calls).
  // We find the function_call item for our tool and parse its arguments.
  const out = response.output || [];
  const call = out.find(
    (item) => item.type === "function_call" && item.name === toolName
  );
  if (!call) {
    // Some SDK variants nest tool calls differently; fallback to scan deeply
    throw new Error(`No tool call found for "${toolName}". Raw output types: ${out.map(o => o.type).join(", ")}`);
  }

  const argsStr = call.arguments;
  if (!argsStr || typeof argsStr !== "string") {
    throw new Error(`Tool call "${toolName}" has no arguments.`);
  }

  try {
    return JSON.parse(argsStr);
  } catch (e) {
    throw new Error(`Failed to parse tool args JSON for "${toolName}": ${e.message}\nArgs: ${argsStr}`);
  }
}

// -------------------------------
// TOOL: Build Blueprint (Prompt -> Blueprint JSON)
// -------------------------------
const TOOL_BUILD_BLUEPRINT = {
  type: "function",
  name: "build_server_blueprint",
  description:
    "Generate a Discord server blueprint (roles/categories/channels/messages) from a user prompt.",
  // IMPORTANT: This is JSON Schema for function parameters, not Structured Outputs schema.
  // Optional fields are allowed normally here.
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Server name" },
      language: { type: "string", enum: ["EN", "HE", "EN+HE"] },
      theme: { type: "string" },

      roles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            name: { type: "string" },
            color: { type: "string", description: "Hex color like #000000" },
            permPack: {
              type: "string",
              enum: ["owner", "admin", "mod", "helper", "verified", "member", "ping"]
            },
            hoist: { type: "boolean" },
            mentionable: { type: "boolean" }
          },
          required: ["key", "name", "color", "permPack"]
        }
      },

      categories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            name: { type: "string" },
            overwrites: {
              type: "array",
              description: "Optional permission overwrites",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  // Use either target="@everyone" or targetRoleKey="mod_role_key"
                  target: { type: "string", description: "Use '@everyone' or empty" },
                  targetRoleKey: { type: "string", description: "Role key from roles[] or empty" },
                  allow: { type: "array", items: { type: "string" } },
                  deny: { type: "array", items: { type: "string" } }
                },
                required: ["target", "targetRoleKey", "allow", "deny"]
              }
            },
            channels: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["text"] },
                  key: { type: "string" },
                  name: { type: "string", description: "lowercase-with-dashes" },
                  topic: { type: "string" },
                  slowmode: { type: "number" }
                },
                required: ["type", "key", "name"]
              }
            }
          },
          required: ["key", "name", "channels"]
        }
      },

      messages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            channelKey: { type: "string" },
            type: { type: "string", enum: ["embed", "text"] },
            title: { type: "string" },
            description: { type: "string" },
            content: { type: "string" }
          },
          required: ["channelKey", "type"]
        }
      }
    },
    required: ["name", "language", "theme", "roles", "categories"]
  }
};

// -------------------------------
// TOOL: Edit Actions (Prompt -> Actions JSON)
// -------------------------------
const TOOL_EDIT_ACTIONS = {
  type: "function",
  name: "build_edit_actions",
  description:
    "Convert natural language edit request into structured Discord edit actions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: [
                "edit_role_color",
                "rename_role",
                "rename_channel",
                "rename_category",
                "create_channel",
                "lock_channel",
                "unlock_channel",
                "set_slowmode"
              ]
            },
            roleName: { type: "string" },
            channelName: { type: "string" },
            categoryName: { type: "string" },
            newName: { type: "string" },
            color: { type: "string" },
            createChannelName: { type: "string" },
            inCategoryName: { type: "string" },
            slowmode: { type: "number" }
          },
          required: ["action"]
        }
      }
    },
    required: ["actions"]
  }
};

// -------------------------------
// Routes
// -------------------------------
app.get("/", (req, res) => res.json({ ok: true, port: PORT }));

// Prompt -> Blueprint JSON (tool calling)
app.post("/ai/blueprint", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt" });
  }

  const system = [
    "You are a Discord server blueprint generator.",
    "You must call the tool build_server_blueprint with a valid blueprint.",
    "Rules:",
    "- Keys must be short, unique, stable (e.g. 'rules', 'chat', 'staff_chat').",
    "- Channel names must be lowercase-with-dashes (no emojis).",
    "- Keep it realistic: 6-25 channels max.",
    "- Use permPack only: owner, admin, mod, helper, verified, member, ping.",
    "- Always include roles/categories arrays.",
    "- If bilingual requested, set language EN+HE and include bilingual rules/welcome in messages.",
    "Defaults if unsure:",
    "- role.hoist=false",
    "- role.mentionable=false",
    "- channel.topic=''",
    "- channel.slowmode=0",
    "- category.overwrites=[]",
    "- messages=[]"
  ].join("\n");

  try {
    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      tools: [TOOL_BUILD_BLUEPRINT],
      tool_choice: { type: "function", name: "build_server_blueprint" }
    });

    const blueprint = getToolArgs(response, "build_server_blueprint");

    // Quick sanity patch: ensure optional fields exist so your bot doesn't crash
    blueprint.roles = (blueprint.roles || []).map(r => ({
      ...r,
      hoist: typeof r.hoist === "boolean" ? r.hoist : false,
      mentionable: typeof r.mentionable === "boolean" ? r.mentionable : false
    }));

    blueprint.categories = (blueprint.categories || []).map(c => ({
      ...c,
      overwrites: Array.isArray(c.overwrites) ? c.overwrites : [],
      channels: Array.isArray(c.channels) ? c.channels : []
    }));

    blueprint.messages = Array.isArray(blueprint.messages) ? blueprint.messages : [];

    return res.json({ blueprint });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Prompt -> Edit actions JSON (tool calling)
app.post("/ai/edits", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt" });
  }

  const system = [
    "You convert user edit requests into structured Discord edit actions.",
    "You must call the tool build_edit_actions.",
    "Rules:",
    "- Prefer exact role/channel/category names the user wrote.",
    "- If an action doesn't need a field, set it to empty string or 0.",
    "- If user asks something unsafe (e.g., give @everyone admin), output actions: []"
  ].join("\n");

  try {
    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      tools: [TOOL_EDIT_ACTIONS],
      tool_choice: { type: "function", name: "build_edit_actions" }
    });

    const edits = getToolArgs(response, "build_edit_actions");
    edits.actions = Array.isArray(edits.actions) ? edits.actions : [];

    return res.json({ edits });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ API running on http://localhost:${PORT}`);
});