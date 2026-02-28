require("dotenv").config();
const path = require("path");

// =========================
// START API
// =========================
require("./api/index.js");

// =========================
// START BOT
// =========================
require("./bot/index.js");

console.log("🚀 Combined server started.");