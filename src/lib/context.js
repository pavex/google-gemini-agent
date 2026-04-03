"use strict";

const ui = require("./ui");

// =============================================================================
// CONTEXT — token estimation + sliding window trim
// =============================================================================

// Rough estimate: 1 token ≈ 4 chars
function estimateTokens(messages) {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(p => (typeof p === "string" ? p : p.text || "")).join("")
        : "";
    return sum + Math.ceil(content.length / 4);
  }, 0);
}

function usageRatio(messages, config) {
  return estimateTokens(messages) / config.context.max_tokens;
}

function shouldCompact(messages, config) {
  const threshold = config.context.compact_threshold ?? 0.75;
  return usageRatio(messages, config) >= threshold;
}

// ---------------------------------------------------------------------------
// trimContext — sliding window: drop oldest user/assistant pairs
// Keeps system message at index 0 (if present).
// ---------------------------------------------------------------------------
function trimContext(messages, config, rl) {
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const history   = systemMsg ? messages.slice(1) : [...messages];

  const maxTokens  = config.context.max_tokens;
  const trimTokens = config.context.trim_to_tokens;
  const before     = estimateTokens(history);

  if (estimateTokens(messages) <= maxTokens) return messages;

  let trimmed = [...history];

  while (estimateTokens(trimmed) > trimTokens && trimmed.length >= 2) {
    // Drop oldest user message and the assistant response after it
    const firstUser = trimmed.findIndex(m => m.role === "user");
    if (firstUser === -1) break;
    // Find the next assistant after firstUser
    const nextAssistant = trimmed.findIndex((m, i) => i > firstUser && m.role === "assistant");
    const cutTo = nextAssistant !== -1 ? nextAssistant + 1 : firstUser + 1;
    trimmed = trimmed.slice(cutTo);
  }

  // Ensure we start with a user message
  while (trimmed.length > 0 && trimmed[0].role !== "user") {
    trimmed = trimmed.slice(1);
  }

  const after = estimateTokens(trimmed);
  if (after < before) {
    ui.printSystem(`Context trimmed — ~${before} → ~${after} tokens`, rl);
  }

  return systemMsg ? [systemMsg, ...trimmed] : trimmed;
}

module.exports = { estimateTokens, usageRatio, shouldCompact, trimContext };
