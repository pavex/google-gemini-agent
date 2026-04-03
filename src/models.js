#!/usr/bin/env node
"use strict";

/**
 * Gemini Model Tester
 *
 * Usage:
 *   node bundle/models.js [API_KEY]          – list & test all models
 *   node bundle/models.js [API_KEY] --setup  – write working models to models.json
 *
 * Only models supporting generateContent + function calling are included.
 * models.json is written next to the config file (cwd) or at --output=path.
 */

const fs   = require("fs");
const path = require("path");

const BASE_URL      = "https://generativelanguage.googleapis.com/v1beta/";
const TEST_PROMPT   = "Reply with your model name only, nothing else.";
const REQUEST_DELAY = 400; // ms between requests

// Minimal dummy tool — tests function-calling support
const DUMMY_TOOLS = [{
  functionDeclarations: [{
    name:        "ping",
    description: "Test tool.",
    parameters:  { type: "object", properties: {} }
  }]
}];

const pad      = (s, n) => String(s).padEnd(n);
const truncate = (s, n = 42) => s.length > n ? s.slice(0, n - 3) + "..." : s;
const sleep    = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchModels(apiKey) {
  const url = `${BASE_URL}models?key=${apiKey}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      console.error(`ERROR fetching model list: HTTP ${res.status} – ${data.error?.message || res.statusText}`);
      return [];
    }
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => ({
        name:             m.name.replace("models/", ""),
        inputTokenLimit:  m.inputTokenLimit  || 0,
        outputTokenLimit: m.outputTokenLimit || 0,
      }));
  } catch (err) {
    console.error(`ERROR fetching model list: ${err.message}`);
    return [];
  }
}

async function testModel(name, apiKey) {
  const url = `${BASE_URL}models/${name}:generateContent?key=${apiKey}`;
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contents: [{ parts: [{ text: TEST_PROMPT }] }] }),
    });
    const json = await res.json();
    if (res.status === 429) return { status: "QUOTA",   detail: json.error?.message || "quota exceeded" };
    if (!res.ok)            return { status: "ERROR",   detail: `HTTP ${res.status}: ${json.error?.message || res.statusText}` };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty)";
    return { status: "OK", detail: text.trim() };
  } catch (err) {
    return { status: "NETWORK", detail: err.message };
  }
}

async function testModelTools(name, apiKey) {
  const url = `${BASE_URL}models/${name}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }],
        tools:    DUMMY_TOOLS,
      }),
    });
    return res.status !== 400;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeModelsJson(results, outputPath) {
  const sorted = [...results]
    .filter(r => r.status === "OK" || r.status === "QUOTA")
    .sort((a, b) => {
      const order = { OK: 0, QUOTA: 1 };
      const oa = order[a.status] ?? 2;
      const ob = order[b.status] ?? 2;
      if (oa !== ob) return oa - ob;
      return (b.inputTokenLimit || 0) - (a.inputTokenLimit || 0);
    });

  const names      = sorted.map(r => r.name);
  const okCount    = sorted.filter(r => r.status === "OK").length;
  const quotaCount = sorted.filter(r => r.status === "QUOTA").length;

  fs.writeFileSync(outputPath, JSON.stringify(names, null, 2) + "\n", "utf8");
  console.log(`\nmodels.json updated: ${names.length} models (OK: ${okCount}, QUOTA: ${quotaCount})`);
  console.log(`Path: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args       = process.argv.slice(2);
  const doSetup    = args.includes("--setup");
  const outputArg  = args.find(a => a.startsWith("--output="));
  const outputPath = outputArg
    ? path.resolve(outputArg.slice("--output=".length))
    : path.resolve(process.cwd(), "models.json");
  const apiKey     = args.find(a => !a.startsWith("--")) || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("ERROR: API key not provided. Set GEMINI_API_KEY or pass as CLI argument.");
    console.error("Usage: node bundle/models.js [API_KEY] [--setup] [--output=path/to/models.json]");
    process.exit(1);
  }

  console.log("Fetching model list from Google API...");
  const models = await fetchModels(apiKey);

  if (models.length === 0) {
    console.log("No models found.");
    return;
  }

  models.sort((a, b) => b.inputTokenLimit - a.inputTokenLimit);
  console.log(`Found ${models.length} models supporting generateContent.\n`);
  console.log(`${"MODEL".padEnd(42)} ${"STATUS".padEnd(9)} DETAIL`);
  console.log("-".repeat(82));

  const results = [];

  for (const model of models) {
    let { status, detail } = await testModel(model.name, apiKey);
    await sleep(REQUEST_DELAY);

    if (status === "OK") {
      const hasTools = await testModelTools(model.name, apiKey);
      if (!hasTools) {
        status = "NO_TOOLS";
        detail = "no function-calling support";
      }
      await sleep(REQUEST_DELAY);
    }

    results.push({ ...model, status, detail });
    console.log(`${pad(model.name, 42)} ${pad(status, 9)} ${truncate(detail)}`);
  }

  console.log("-".repeat(82));
  const ok      = results.filter(r => r.status === "OK").length;
  const quota   = results.filter(r => r.status === "QUOTA").length;
  const noTools = results.filter(r => r.status === "NO_TOOLS").length;
  const err     = results.length - ok - quota - noTools;
  console.log(`Summary: OK: ${ok}  QUOTA: ${quota}  NO_TOOLS: ${noTools}  ERROR/NETWORK: ${err}`);

  if (doSetup) {
    writeModelsJson(results, outputPath);
  } else {
    console.log("\nRun with --setup to write working models to models.json.");
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
