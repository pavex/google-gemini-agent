"use strict";

// =============================================================================
// UI — terminal colors + output helpers
// =============================================================================

const C = {
  RESET:   "\x1b[0m",
  WHITE:   "\x1b[97m",          // agent responses     (bright white)
  GRAY:    "\x1b[90m",          // system notifications, model name, waiting
  DKGRAY:  "\x1b[38;5;238m",   // audit trail         (very dark gray, 256-color)
  BLUE:    "\x1b[94m",          // (reserved)
  CYAN:    "\x1b[96m",          // commands            (bright cyan)
  YELLOW:  "\x1b[93m",          // auto-prompts, incoming messages
  RED:     "\x1b[91m",          // errors
  GREEN:   "\x1b[92m",          // success
};

const WRAP_WIDTH      = 100;
const AUDIT_RESULT_MAX = 300;

let _lastModel    = null;
let _auditVisible = true;

function setAuditVisible(val) { _auditVisible = !!val; }

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function wrapText(text, width) {
  return text.split("\n").map(line => {
    if (line.length <= width) return line;
    const words  = line.split(" ");
    const lines  = [];
    let   current = "";
    for (const word of words) {
      if (current.length + word.length + (current ? 1 : 0) > width) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) lines.push(current);
    return lines.join("\n");
  }).join("\n");
}

function printSafe(msg, rl) {
  process.stdout.write("\r\x1b[K");
  process.stdout.write(msg + "\n");
  if (rl) rl.prompt(true);
}

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

function printSystem(msg, rl)       { printSafe(`${C.GRAY}[${msg}]${C.RESET}`, rl); }
function printAutoPrompt(text, rl)  { printSafe(`${C.YELLOW}> ${text}${C.RESET}`, rl); }
function printError(msg, rl)        { printSafe(`${C.RED}[ERROR] ${msg}${C.RESET}`, rl); }
function printWaiting(identity, rl) { printSafe(`${C.GRAY}Waiting for ${capitalize(identity)}...${C.RESET}`, rl); }

function printAudit(header, payload, status, rl) {
  if (!_auditVisible) return;
  const statusStr = status ? ` [${status}]` : "";
  let preview = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (preview.length > AUDIT_RESULT_MAX) {
    preview = preview.slice(0, AUDIT_RESULT_MAX) + "…";
  }
  const display = preview.includes("\n")
    ? `${header}${statusStr}\n  ${preview.replace(/\n/g, "\n  ")}`
    : `${header}${statusStr}  ${preview}`;
  printSafe(`${C.DKGRAY}${display}${C.RESET}`, rl);
}

function printIncoming(from, text, rl) {
  clearLine();
  process.stdout.write(`${C.YELLOW}${capitalize(from)}: ${text}${C.RESET}\n`);
  if (rl) rl.prompt(true);
}

function printAgent(identity, text, model, rl) {
  clearLine();
  if (model !== _lastModel) {
    process.stdout.write(`${C.GRAY}[${model}]${C.RESET}\n`);
    _lastModel = model;
  }
  const wrapped = wrapText(text, WRAP_WIDTH);
  process.stdout.write(`${C.WHITE}${capitalize(identity)}: ${wrapped}${C.RESET}\n\n`);
  if (rl) rl.prompt(true);
}

function resetLastModel() { _lastModel = null; }

module.exports = {
  C,
  capitalize,
  setAuditVisible,
  printSafe,
  clearLine,
  printSystem,
  printAutoPrompt,
  printIncoming,
  printWaiting,
  printError,
  printAudit,
  printAgent,
  resetLastModel,
};
