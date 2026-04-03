#!/usr/bin/env node
"use strict";

/**
 * Gemini Agent CLI v1.0
 *
 * Usage:  node bundle/agent.js [API_KEY] [--config=custom.json]
 *
 * Uses Vercel AI SDK (ai + @ai-sdk/google)
 * Built-in commands: /help /exit /clear /tools /context /model
 */

const readline = require("readline");
const path     = require("path");
const fs       = require("fs");

const { generateText, stepCountIs, tool } = require("ai");
const { createGoogleGenerativeAI }        = require("@ai-sdk/google");
const { z }                               = require("zod");

const ui                                = require("./lib/ui");
const { loadConfig }                    = require("./lib/config");
const { connectAll, getMergedTools,
        listAllTools, getServerStats,
        disconnectAll }                 = require("./lib/mcp");
const { estimateTokens, usageRatio,
        trimContext }                   = require("./lib/context");

// =============================================================================
// BUILT-IN TOOLS
// =============================================================================

const builtinTools = {
  get_current_datetime: tool({
    description: "Returns the current date and time. Use this whenever you need to know today's date, current time, day of week, or any time-related information.",
    parameters: z.object({}),
    execute: async () => {
      const now = new Date();
      return {
        iso:      now.toISOString(),
        date:     now.toLocaleDateString("cs-CZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        time:     now.toLocaleTimeString("cs-CZ"),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    },
  }),
};

// =============================================================================
// SKILLS
// =============================================================================

function loadSkills(config) {
  const skillsDir = path.resolve(process.cwd(), config.skills_dir ?? "skills");
  if (!fs.existsSync(skillsDir)) return {};

  const skills = {};
  const files  = fs.readdirSync(skillsDir).filter(f => f.endsWith(".js"));

  for (const file of files) {
    try {
      const skill = require(path.join(skillsDir, file));
      if (skill && typeof skill === "object") {
        Object.assign(skills, skill);
        ui.printSystem(`Skill loaded: ${file}`);
      }
    } catch (err) {
      ui.printError(`Skill load failed (${file}): ${err.message}`);
    }
  }
  return skills;
}

// =============================================================================
// ACTIVE MODEL
// =============================================================================

let _activeModel = null;

function getActiveModel(config) {
  return _activeModel || config._models?.[0] || config.model;
}

function isFallbackError(err) {
  const msg = (err?.message ?? "").toLowerCase();
  return (
    msg.includes("quota")              ||
    msg.includes("429")                ||
    msg.includes("resource_exhausted") ||
    msg.includes("not found")          ||
    msg.includes("is not supported")   ||
    msg.includes("deprecated")
  );
}

// ---------------------------------------------------------------------------
// debugDump — zapíše strukturu result.steps do agent-debug.json
// ---------------------------------------------------------------------------
function debugDump(result, modelId) {
  try {
    const dump = {
      modelId,
      text:        result.text,
      finishReason: result.finishReason,
      stepsCount:  result.steps?.length,
      steps: (result.steps ?? []).map((s, i) => {
        const step = {
          index:            i,
          text:             s.text,
          finishReason:     s.finishReason,
          toolCallsCount:   s.toolCalls?.length,
          toolResultsCount: s.toolResults?.length,
        };
        if (s.toolResults?.length) {
          step.toolResults = s.toolResults.map(r => ({
            toolName:      r.toolName,
            hasResult:     "result" in r,
            hasOutput:     "output" in r,
            resultType:    typeof r.result,
            outputType:    typeof r.output,
            resultPreview: JSON.stringify(r.result)?.slice(0, 150),
            outputPreview: JSON.stringify(r.output)?.slice(0, 150),
          }));
        }
        return step;
      }),
    };
    fs.writeFileSync("agent-debug.json", JSON.stringify(dump, null, 2), "utf8");
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// extractFallbackText — sestaví odpověď z tool výsledků když model vrátí ""
//
// ai-sdk v6 DefaultStepResult.toolResults:
//   content.filter(p => p.type === "tool-result")
//   každý má: toolName, toolCallId, input, OUTPUT (ne result!)
//
// Pozor: output může být { type: "text", value: "..." } nebo { type: "json", value: {...} }
// ---------------------------------------------------------------------------
function extractFallbackText(result) {
  if (!result.steps?.length) return "";

  const parts = [];

  for (const step of result.steps) {
    if (!Array.isArray(step.toolResults) || step.toolResults.length === 0) continue;

    for (const tr of step.toolResults) {
      // ai-sdk v6: property je .output (ne .result)
      // .output může být: { type: "text", value: "..." } nebo { type: "json", value: {...} }
      // nebo přímo string/object (starší verze)
      let val = tr.output ?? tr.result;

      if (val === undefined || val === null || val === "") continue;

      // Rozbalení output wrapperu { type, value }
      if (typeof val === "object" && "value" in val && "type" in val) {
        val = val.value;
      }

      if (typeof val === "string" && val.trim()) {
        parts.push(val.trim());
      } else if (val !== null && val !== undefined) {
        const json = JSON.stringify(val, null, 2);
        if (json && json !== "null") parts.push(json);
      }
    }
  }

  return parts.join("\n\n");
}

// =============================================================================
// CALL AGENT — s model fallback
// =============================================================================

async function callAgent(messages, config, google, tools) {
  const allModels = config._models ?? [config.model];
  const modelList = _activeModel
    ? [_activeModel, ...allModels.filter(m => m !== _activeModel)]
    : allModels;

  const sessionTimeoutMs = config.session_timeout_ms ?? 180_000;

  let lastError = null;

  for (const modelId of modelList) {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(new Error("session timeout")), sessionTimeoutMs);

      let result;
      try {
        result = await generateText({
          model:       google(modelId),
          messages,
          tools,
          stopWhen:    stepCountIs(config.max_steps ?? 25),
          system:      config.instructions?.system ?? undefined,
          abortSignal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (_activeModel !== modelId) {
        if (_activeModel !== null) ui.printSystem(`Model switched: ${_activeModel} → ${modelId}`);
        _activeModel = modelId;
      }

      let text = result.text?.trim() ?? "";

      if (!text) {
        debugDump(result, modelId);
        text = extractFallbackText(result).trim();
        if (text) {
          ui.printSystem("(model neodpověděl — zobrazuji výsledky tool callů)", null);
        }
      }

      if (!text) text = "(žádná odpověď — debug v agent-debug.json)";

      return { text, modelId, steps: result.steps?.length ?? 0 };

    } catch (err) {
      lastError = err;

      if (err?.message === "session timeout") {
        throw new Error(`Session timeout (${sessionTimeoutMs / 1000}s) — zkus jednodušší dotaz nebo zvyš session_timeout_ms v configu.`);
      }

      if (isFallbackError(err)) {
        ui.printSystem(`${modelId} → unavailable (${err.message.slice(0, 60)}...), trying next...`);
        if (_activeModel === modelId) _activeModel = null;
        continue;
      }

      throw err;
    }
  }

  throw new Error(`All models failed. Last error: ${lastError?.message ?? "unknown"}`);
}

// =============================================================================
// WAKE PROMPT
// =============================================================================

async function sendWakePrompt(identity, config, google, tools, messagesRef, rl) {
  const wakeText = config.instructions?.wake_prompt;
  if (!wakeText) return;

  ui.printAutoPrompt(wakeText, rl);
  ui.printWaiting(identity, rl);

  const tempMessages = [...messagesRef.value, { role: "user", content: wakeText }];

  try {
    const { text, modelId } = await callAgent(tempMessages, config, google, tools);
    ui.clearLine();
    ui.printAgent(identity, text, modelId, rl);
    messagesRef.value.push({ role: "user",      content: wakeText });
    messagesRef.value.push({ role: "assistant", content: text });
  } catch (err) {
    ui.clearLine();
    ui.printError(`Wake prompt failed: ${err.message}`, rl);
  }
}

// =============================================================================
// /tools
// =============================================================================

function printTools(allTools, rl) {
  const mcpTools  = listAllTools();
  const builtins  = Object.keys(builtinTools);
  const mcpNames  = new Set(mcpTools.map(t => t.name));
  const skillKeys = Object.keys(allTools).filter(k => !builtins.includes(k) && !mcpNames.has(k));

  ui.printSafe(`${ui.C.CYAN}--- Tools (${Object.keys(allTools).length} total) ---${ui.C.RESET}`, rl);

  ui.printSafe(`${ui.C.CYAN}[built-in]${ui.C.RESET}`, rl);
  for (const k of builtins) {
    ui.printSafe(`  ${ui.C.WHITE}${k}${ui.C.RESET}  ${ui.C.GRAY}${allTools[k]?.description?.slice(0, 72) ?? ""}${ui.C.RESET}`, rl);
  }

  let lastServer = null;
  for (const t of mcpTools) {
    if (t.serverName !== lastServer) {
      ui.printSafe(`${ui.C.CYAN}[MCP: ${t.serverName}]${ui.C.RESET}`, rl);
      lastServer = t.serverName;
    }
    ui.printSafe(`  ${ui.C.WHITE}${t.name}${ui.C.RESET}  ${ui.C.GRAY}${t.description}${ui.C.RESET}`, rl);
  }

  if (skillKeys.length > 0) {
    ui.printSafe(`${ui.C.CYAN}[skills]${ui.C.RESET}`, rl);
    for (const k of skillKeys) {
      ui.printSafe(`  ${ui.C.WHITE}${k}${ui.C.RESET}  ${ui.C.GRAY}${allTools[k]?.description?.slice(0, 72) ?? ""}${ui.C.RESET}`, rl);
    }
  }

  if (Object.keys(allTools).length === 0) ui.printSystem("No tools available.", rl);
  ui.printSafe(`${ui.C.CYAN}---${ui.C.RESET}`, rl);
}

// =============================================================================
// /context
// =============================================================================

function printContext(messages, config, rl) {
  const ratio     = usageRatio(messages, config);
  const pct       = Math.round(ratio * 100);
  const used      = estimateTokens(messages);
  const max       = config.context.max_tokens;
  const threshold = Math.round((config.context.compact_threshold ?? 0.75) * 100);
  const filled    = Math.round(ratio * 30);
  const bar       = "█".repeat(filled) + "░".repeat(30 - filled);
  ui.printSafe(`${ui.C.CYAN}Context: [${bar}] ${pct}% (~${used}/${max} tokens, compaction at ${threshold}%)${ui.C.RESET}`, rl);
}

// =============================================================================
// /help
// =============================================================================

function printHelp(config, rl) {
  const models = config._models ?? [config.model];
  ui.printSafe(`${ui.C.CYAN}--- Commands ---${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/help${ui.C.RESET}     ${ui.C.GRAY}Show this help${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/exit${ui.C.RESET}     ${ui.C.GRAY}Exit the agent${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/clear${ui.C.RESET}    ${ui.C.GRAY}Clear conversation history${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/tools${ui.C.RESET}    ${ui.C.GRAY}List available tools${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/context${ui.C.RESET}  ${ui.C.GRAY}Show context window usage${ui.C.RESET}`, rl);
  ui.printSafe(`  ${ui.C.WHITE}/model${ui.C.RESET}    ${ui.C.GRAY}Show active model  (${models.length} in pool)${ui.C.RESET}`, rl);
  ui.printSafe(`${ui.C.CYAN}---${ui.C.RESET}`, rl);
}

// =============================================================================
// BANNER
// =============================================================================

function printBanner(config, stats) {
  const titleIdentity = config.identity ? ` (${ui.capitalize(config.identity)})` : "";
  const mcpInfo = stats.count > 0
    ? `${stats.count} server${stats.count !== 1 ? "s" : ""} (${stats.names.join(", ")})  |  ${stats.toolCount} tool${stats.toolCount !== 1 ? "s" : ""}`
    : "none";
  const models    = config._models ?? [config.model];
  const modelInfo = models.length > 1
    ? `${getActiveModel(config)}  (+${models.length - 1} fallback${models.length > 2 ? "s" : ""})`
    : getActiveModel(config);

  process.stdout.write(`${ui.C.WHITE}Gemini Agent CLI v1.0${titleIdentity}${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}Model:   ${modelInfo}${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}MCP:     ${mcpInfo}${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}Context: ${config.context.max_tokens} tokens max (compaction at ${Math.round((config.context.compact_threshold ?? 0.75) * 100)}%)${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}Audit:   ${config.audit?.show !== false ? "visible" : "hidden"}${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}Type /help for commands.${ui.C.RESET}\n`);
  process.stdout.write(`${ui.C.GRAY}${"-".repeat(55)}${ui.C.RESET}\n`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  process.stdout.write(process.platform === "win32" ? "\x1Bc" : "\x1B[2J\x1B[3J\x1B[H");

  const config   = loadConfig();
  const identity = config.identity || "agent";

  ui.setAuditVisible(config.audit?.show ?? true);

  const cliKey = process.argv.slice(2).find(a => !a.startsWith("--"));
  const apiKey = cliKey || config.api_key || process.env.GEMINI_API_KEY || "";

  if (!apiKey) {
    console.error("ERROR: API key not provided.");
    console.error("Options: CLI argument, api_key in config, or GEMINI_API_KEY env.");
    process.exit(1);
  }
  if (config.api_key && config.api_key.length > 0) {
    ui.printSystem("Warning: api_key stored in plaintext in config");
  }
  config._apiKey = apiKey;

  _activeModel = config._models?.[0] ?? config.model;

  const google = createGoogleGenerativeAI({ apiKey });

  try { await connectAll(config); }
  catch (err) { console.error(`\nFATAL: ${err.message}`); process.exit(1); }

  const skillTools = loadSkills(config);
  const allTools   = { ...builtinTools, ...getMergedTools(), ...skillTools };
  const stats      = getServerStats();

  printBanner(config, stats);

  const shutdown = async () => { await disconnectAll(); process.exit(0); };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  const messagesRef = { value: [] };
  const isBusyRef   = { value: false };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("close", shutdown);

  isBusyRef.value = true;
  await sendWakePrompt(identity, config, google, allTools, messagesRef, rl);
  isBusyRef.value = false;

  // ============================================================================
  // PROMPT LOOP
  // ============================================================================

  const prompt = () => rl.question("You: ", async (input) => {
    const text = input.trim();
    if (!text) { prompt(); return; }
    if (isBusyRef.value) { ui.printSystem("Busy, please wait...", rl); prompt(); return; }

    if (text === "/exit")    { console.log("Bye!"); rl.close(); return; }
    if (text === "/help")    { printHelp(config, rl);                         prompt(); return; }
    if (text === "/tools")   { printTools(allTools, rl);                      prompt(); return; }
    if (text === "/context") { printContext(messagesRef.value, config, rl);   prompt(); return; }
    if (text === "/model") {
      const models = config._models ?? [config.model];
      ui.printSystem(`Active: ${getActiveModel(config)}  |  Pool (${models.length}): ${models.join(", ")}`, rl);
      prompt(); return;
    }
    if (text === "/clear") {
      messagesRef.value = [];
      ui.resetLastModel();
      ui.printSystem("History cleared", rl);
      prompt(); return;
    }
    if (text.startsWith("/")) {
      ui.printSystem(`Unknown command: ${text}  (type /help for list)`, rl);
      prompt(); return;
    }

    isBusyRef.value = true;
    messagesRef.value.push({ role: "user", content: text });
    messagesRef.value = trimContext(messagesRef.value, config, rl);
    ui.printWaiting(identity, rl);

    try {
      const { text: reply, modelId, steps } = await callAgent(messagesRef.value, config, google, allTools);
      ui.clearLine();
      ui.printAgent(identity, reply, modelId, rl);
      if (steps > 1) ui.printSystem(`(${steps} steps — ${steps - 1} tool call round${steps - 1 !== 1 ? "s" : ""})`, rl);
      messagesRef.value.push({ role: "assistant", content: reply });
      messagesRef.value = trimContext(messagesRef.value, config, rl);
    } catch (err) {
      ui.clearLine();
      ui.printError(err.message, rl);
      messagesRef.value.pop();
    } finally {
      isBusyRef.value = false;
    }

    prompt();
  });

  prompt();
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
