"use strict";

const fs   = require("fs");
const path = require("path");
const ui   = require("./ui");

// =============================================================================
// CONFIG
// =============================================================================

const DEFAULT_CONFIG_FILE = "agent.json";

const BUILTIN_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

const INSTRUCTION_DEFAULTS = {
  system:
    "You are an autonomous AI agent running in a CLI with access to MCP tools. " +
    "Act immediately and completely — never wait for the user to say 'continue'.\n\n" +

    "AUTONOMY RULES:\n" +
    "- Complete the full task chain in one response. If step 1 reveals missing context, " +
    "resolve it (step 2, 3...) and finish the original task — all in the same turn.\n" +
    "- ALWAYS write a text response to the user after tool calls. NEVER return empty text. " +
    "After every tool call, summarize what you found or did in plain language.\n" +
    "- If a tool returns 'No project selected': call list_projects, pick the right one, " +
    "call select_project, then retry the original tool — without asking the user.\n" +
    "- If a tool result is empty or unclear: try the next logical step before reporting back.\n" +
    "- Only stop and ask when there is genuine ambiguity no tool can resolve.\n\n" +

    "MEMORY RULES:\n" +
    "- START of every session: call memory read/knowledge immediately.\n" +
    "- After learning something worth keeping: call memory append.\n" +
    "- 'do you remember' / 'check memory': call memory tool first, then answer.\n" +
    "- Never claim to have memory without actually reading it.\n\n" +

    "TOOL RULES:\n" +
    "- Use tools proactively — not only when explicitly asked.\n" +
    "- You always have get_current_datetime — use it when date/time is relevant.\n" +
    "- Never invent a tool result. If a tool fails, report the real error.\n\n" +

    "STYLE:\n" +
    "- Brief and direct. Max 2-3 sentences unless more is needed.\n" +
    "- No filler ('Great!', 'Certainly!', 'Of course!').\n" +
    "- Respond in the same language the user writes in.",

  wake_prompt:
    "Session started.\n" +
    "Read your memory and shared memory if available. Summarise where we left off and what's pending. Suggest the next step."
};

const CONFIG_DEFAULTS = {
  identity: "agent",
  api_key:  "",
  model:    "gemini-2.5-flash",
  context: {
    max_tokens:        8000,
    trim_to_tokens:    6000,
    compact_threshold: 0.75
  },
  audit: {
    show: true
  },
  mcp: {
    servers: []
  },
  max_steps:          25,
  fetch_timeout_ms:   30000,
  session_timeout_ms: 180000,
  skills_dir:         "skills",
  instructions:       INSTRUCTION_DEFAULTS
};

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------
function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides || {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (Array.isArray(overrides[key])) {
      result[key] = overrides[key];
    } else if (overrides[key] !== null && typeof overrides[key] === "object") {
      result[key] = deepMerge(defaults[key] || {}, overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// loadInstructions
//
// Podporované formáty v config.instructions:
//
//   1. Objekt se string hodnotami — přímý obsah (jako dřív):
//      "instructions": { "system": "...", "wake_prompt": "..." }
//
//   2. Objekt kde hodnoty jsou cesty k .md souborům:
//      "instructions": { "system": "karel-system.md", "wake_prompt": "karel-wake.md" }
//
// Pokud soubor neexistuje, použije se INSTRUCTION_DEFAULTS a vypíše varování.
// ---------------------------------------------------------------------------
function loadInstructions(raw, configDir) {
  if (!raw || typeof raw !== "object") {
    return { ...INSTRUCTION_DEFAULTS };
  }

  const result = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      result[key] = value;
      continue;
    }

    // Detekce: je to cesta k souboru?
    const looksLikePath = value.endsWith(".md") || value.endsWith(".txt") ||
                          value.includes("/") || value.includes("\\");

    if (!looksLikePath) {
      result[key] = value;
      continue;
    }

    // Resolve cesty — relativní k adresáři configu
    const filePath = path.isAbsolute(value)
      ? value
      : path.join(configDir, value);

    if (fs.existsSync(filePath)) {
      try {
        result[key] = fs.readFileSync(filePath, "utf8").trimEnd();
        ui.printSystem(`Instructions [${key}] loaded from ${path.basename(filePath)}`);
      } catch (err) {
        ui.printSystem(`Instructions [${key}] read error: ${err.message} — using default`);
        result[key] = INSTRUCTION_DEFAULTS[key] ?? "";
      }
    } else {
      ui.printSystem(`Instructions [${key}] file not found: ${value} — using default`);
      result[key] = INSTRUCTION_DEFAULTS[key] ?? "";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// loadModels
// ---------------------------------------------------------------------------
function loadModels(config, configPath) {
  const configDir  = path.dirname(configPath);
  const modelsPath = path.join(configDir, "models.json");

  if (fs.existsSync(modelsPath)) {
    try {
      const raw  = fs.readFileSync(modelsPath, "utf8");
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        ui.printSystem(`Models loaded from models.json (${list.length} models)`);
        return list;
      }
    } catch (err) {
      ui.printSystem(`models.json parse error: ${err.message} — using fallback`);
    }
  }

  if (Array.isArray(config.model_fallbacks) && config.model_fallbacks.length > 0) {
    return config.model_fallbacks;
  }

  const builtin = [...BUILTIN_MODELS];
  if (config.model && !builtin.includes(config.model)) {
    builtin.unshift(config.model);
  }
  return builtin;
}

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------
function resolveConfigPath() {
  const arg  = process.argv.slice(2).find(a => a.startsWith("--config="));
  const file = arg ? arg.slice("--config=".length) : DEFAULT_CONFIG_FILE;
  return path.resolve(process.cwd(), file);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------
function loadConfig() {
  const configPath = resolveConfigPath();
  const configDir  = path.dirname(configPath);
  const configFile = path.basename(configPath);

  let config = deepMerge(CONFIG_DEFAULTS, {});

  if (fs.existsSync(configPath)) {
    try {
      const raw  = fs.readFileSync(configPath, "utf8");
      const data = JSON.parse(raw);
      config = deepMerge(CONFIG_DEFAULTS, data);
      ui.printSystem(`Config loaded from ${configFile}`);
    } catch (err) {
      ui.printSystem(`Config parse error: ${err.message} — using defaults`);
    }
  } else {
    saveConfig(config, configPath);
    ui.printSystem(`${configFile} created with defaults`);
  }

  // Načti instructions — podporuje .md soubory
  config.instructions = loadInstructions(config.instructions, configDir);

  config._configPath = configPath;
  config._models     = loadModels(config, configPath);

  return config;
}

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------
function saveConfig(config, configPath) {
  const p = configPath || config._configPath || path.resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  const { _apiKey, _configPath, _models, ...toSave } = config;
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

module.exports = { CONFIG_DEFAULTS, INSTRUCTION_DEFAULTS, loadConfig, saveConfig };
