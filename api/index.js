require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 5050;

// =======================================
// SAFE OLLAMA CALL
// =======================================
async function callOllama(systemPrompt, userPrompt) {
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3", // change to mistral if needed
      prompt: `${systemPrompt}\n\nUser request:\n${userPrompt}`,
      stream: false
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Ollama HTTP error: " + text);
  }

  const data = await response.json();

  if (!data || typeof data.response !== "string") {
    console.log("DEBUG OLLAMA RAW:", data);
    throw new Error("Ollama returned invalid response");
  }

  return data.response;
}

// =======================================
// SAFE JSON EXTRACTION
// =======================================
function extractJSON(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Model returned empty response");
  }

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");

  if (start === -1 || end === -1) {
    console.log("MODEL OUTPUT:", rawText);
    throw new Error("Model did not return valid JSON");
  }

  const jsonString = rawText.substring(start, end + 1);

  try {
    return JSON.parse(jsonString);
  } catch (err) {
    console.log("JSON PARSE ERROR RAW:", rawText);
    throw new Error("Failed to parse model JSON");
  }
}

// =======================================
// HEALTH CHECK
// =======================================
app.get("/", (req, res) => {
  res.json({ ok: true, ai: "ollama", port: PORT });
});

// =======================================
// BUILD BLUEPRINT ROUTE
// =======================================
app.post("/ai/blueprint", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt" });
  }

  const system = `
You generate Discord server blueprint JSON.
Return ONLY valid JSON.

Structure:

{
  "name": string,
  "language": "EN" | "HE" | "EN+HE",
  "theme": string,
  "roles": [
    {
      "key": string,
      "name": string,
      "color": "#RRGGBB",
      "permPack": "owner"|"admin"|"mod"|"helper"|"verified"|"member"|"ping",
      "hoist": boolean,
      "mentionable": boolean
    }
  ],
  "categories": [
    {
      "key": string,
      "name": string,
      "overwrites": [],
      "channels": [
        {
          "type": "text",
          "key": string,
          "name": string,
          "topic": string,
          "slowmode": number
        }
      ]
    }
  ],
  "messages": []
}

Rules:
- Channel names must be lowercase-with-dashes
- Include at least 3 roles
- Include at least 2 categories
- Default:
  hoist=false
  mentionable=false
  topic=""
  slowmode=0
  overwrites=[]
  messages=[]
Return JSON only. No explanation.
`;

  try {
    const raw = await callOllama(system, prompt);
    const blueprint = extractJSON(raw);

    // Safety defaults to prevent bot crashes
    blueprint.roles = (blueprint.roles || []).map(r => ({
      hoist: false,
      mentionable: false,
      ...r
    }));

    blueprint.categories = (blueprint.categories || []).map(c => ({
      overwrites: [],
      channels: [],
      ...c
    }));

    blueprint.messages = blueprint.messages || [];

    return res.json({ blueprint });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =======================================
// EDIT ROUTE
// =======================================
app.post("/ai/edits", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt" });
  }

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

Return JSON only.
If unsure return {"actions":[]}
`;

  try {
    const raw = await callOllama(system, prompt);
    const edits = extractJSON(raw);

    edits.actions = edits.actions || [];

    return res.json({ edits });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =======================================
app.listen(PORT, () => {
  console.log(`✅ Local Ollama AI API running on http://localhost:${PORT}`);
});