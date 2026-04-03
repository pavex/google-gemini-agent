"use strict";

const { spawn } = require("child_process");
const { tool }  = require("ai");
const { z }     = require("zod");
const ui        = require("./ui");

// =============================================================================
// MCP CLIENT — vlastní stdio JSON-RPC 2.0 (kompatibilní s PHP a Node servery)
// @ai-sdk/mcp Experimental_StdioMCPTransport má problémy s non-Node servery.
// Tool names jsou prefixovány názvem serveru: "serverName_toolName"
// =============================================================================

const servers = [];

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

function sendRequest(server, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id    = server.nextId++;
    const msg   = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`[${server.name}] timeout on ${method}`));
    }, 15000);
    server.pending.set(id, { resolve, reject, timer });
    server.proc.stdin.write(msg);
  });
}

function sendNotify(server, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  server.proc.stdin.write(msg);
}

function handleStdout(server, chunk) {
  server.buffer += chunk.toString();
  const lines = server.buffer.split("\n");
  server.buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.id !== undefined && server.pending.has(msg.id)) {
      const { resolve, reject, timer } = server.pending.get(msg.id);
      clearTimeout(timer);
      server.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`[${server.name}] ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// jsonSchemaToZod — JSON Schema → Zod (pro ai-sdk tool() parametry)
// ---------------------------------------------------------------------------

function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.any();

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (schema.enum) {
    if (schema.enum.length === 0) return z.any();
    return z.enum(schema.enum.map(String));
  }

  switch (type) {
    case "string":
      return schema.description ? z.string().describe(schema.description) : z.string();
    case "number":
    case "integer":
      return schema.description ? z.number().describe(schema.description) : z.number();
    case "boolean":
      return schema.description ? z.boolean().describe(schema.description) : z.boolean();
    case "array": {
      const items = schema.items ? jsonSchemaToZod(schema.items) : z.any();
      return schema.description ? z.array(items).describe(schema.description) : z.array(items);
    }
    case "object":
    default: {
      const props = schema.properties;
      if (!props || Object.keys(props).length === 0) {
        return z.object({}).passthrough();
      }
      const required = schema.required ?? [];
      const shape    = {};
      for (const [key, val] of Object.entries(props)) {
        let s = jsonSchemaToZod(val);
        if (!required.includes(key)) s = s.optional();
        shape[key] = s;
      }
      const obj = z.object(shape);
      return schema.description ? obj.describe(schema.description) : obj;
    }
  }
}

// ---------------------------------------------------------------------------
// buildToolSet — převede MCP tools na ai-sdk tool() map
// ---------------------------------------------------------------------------

function buildToolSet(server) {
  const toolSet = {};
  const prefix  = server.name.replace(/[^a-zA-Z0-9_]/g, "_");

  for (const t of server.tools) {
    const prefixedName = `${prefix}_${t._originalName ?? t.name}`;
    const schema       = t.inputSchema ?? { type: "object", properties: {} };
    const zodParams    = jsonSchemaToZod(schema);

    toolSet[prefixedName] = tool({
      description: t.description ?? "",
      parameters:  zodParams,
      execute:     async (args) => {
        const originalName = t._originalName ?? t.name;
        ui.printSystem(`MCP → ${prefixedName}`);
        const result = await callToolOnServer(server, originalName, args);
        if (result.success) {
          const size = formatSize(Buffer.byteLength(result.content, "utf8"));
          ui.printSystem(`MCP ← ${prefixedName}: OK (${size})`);
          return result.content;
        } else {
          ui.printSystem(`MCP ← ${prefixedName}: ERROR — ${result.error}`);
          return `Error: ${result.error}`;
        }
      },
    });
  }

  server._toolSet = toolSet;
  return toolSet;
}

function formatSize(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 * 100) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024).toFixed(0)} kB`;
}

// ---------------------------------------------------------------------------
// callToolOnServer — volá tool na konkrétním serveru
// ---------------------------------------------------------------------------

async function callToolOnServer(server, toolName, toolArgs = {}) {
  try {
    const result  = await sendRequest(server, "tools/call", {
      name: toolName, arguments: toolArgs
    });
    const content = result?.content ?? [];
    const text    = content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (result?.isError) return { success: false, error: text || "Tool returned an error." };
    return { success: true, content: text };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// connect — spustí MCP server a připraví tools
// ---------------------------------------------------------------------------

async function connect(serverConfig) {
  const { name, cmd, args = [], env = {} } = serverConfig;
  ui.printSystem(`MCP connecting: ${name}`);

  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env:   { ...process.env, ...env },
  });

  const server = { name, proc, buffer: "", pending: new Map(), tools: [], nextId: 1, _toolSet: {} };

  proc.stdout.on("data", chunk => handleStdout(server, chunk));
  proc.stderr.on("data", chunk => {
    const msg = chunk.toString().trim();
    if (msg) ui.printSystem(`MCP [${name}] stderr: ${msg}`);
  });
  proc.on("error", err => ui.printError(`MCP [${name}] process error: ${err.message}`));
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) ui.printSystem(`MCP [${name}] exited with code ${code}`);
    for (const { reject, timer } of server.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`[${name}] process exited`));
    }
    server.pending.clear();
  });

  try {
    await sendRequest(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities:    {},
      clientInfo:      { name: "gemini-agent", version: "1.0.0" }
    });
    sendNotify(server, "notifications/initialized");
    const toolsResult = await sendRequest(server, "tools/list");
    server.tools = toolsResult?.tools ?? [];

    // Prefix tool names (store original for calls)
    for (const t of server.tools) {
      t._originalName = t.name;
    }

    buildToolSet(server);
    ui.printSystem(`MCP [${name}] ready — ${server.tools.length} tools`);
    servers.push(server);
    return server;
  } catch (err) {
    ui.printError(`MCP [${name}] handshake failed: ${err.message}`);
    proc.kill();
    return null;
  }
}

// ---------------------------------------------------------------------------
// connectAll
// ---------------------------------------------------------------------------

async function connectAll(config) {
  const list = config?.mcp?.servers ?? [];
  if (list.length === 0) { ui.printSystem("MCP: no servers configured"); return; }
  for (const serverConfig of list) {
    const server = await connect(serverConfig);
    if (!server) {
      throw new Error(`MCP server "${serverConfig.name}" failed to connect. Fix config and restart.`);
    }
  }
}

// ---------------------------------------------------------------------------
// getMergedTools — vrací { toolName: tool() } pro generateText
// ---------------------------------------------------------------------------

function getMergedTools() {
  const merged = {};
  for (const server of servers) {
    Object.assign(merged, server._toolSet);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// listAllTools — pro /tools výpis
// ---------------------------------------------------------------------------

function listAllTools() {
  const result = [];
  for (const server of servers) {
    for (const t of server.tools) {
      result.push({
        serverName:  server.name,
        name:        t._originalName ?? t.name,
        description: t.description ?? "",
      });
    }
  }
  return result;
}

function getServerStats() {
  return {
    count:     servers.length,
    names:     servers.map(s => s.name),
    toolCount: servers.reduce((sum, s) => sum + s.tools.length, 0),
  };
}

function disconnectAll() {
  for (const server of servers) {
    try {
      sendNotify(server, "notifications/cancelled", {});
      server.proc.stdin.end();
    } catch { /* ignore */ }
  }
  servers.length = 0;
}

module.exports = { connectAll, getMergedTools, listAllTools, getServerStats, disconnectAll };
