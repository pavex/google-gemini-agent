# Gemini Agent CLI

A CLI agent built on **Vercel AI SDK** (`ai` + `@ai-sdk/google`) with support for MCP (Model Context Protocol) servers.

## Usage

```bash
# Build
npm run build

# Run (API key as an argument)
node bundle/agent.js YOUR_API_KEY

# Or via npm
npm run dev YOUR_API_KEY

# Alternatively via environment variable
set GEMINI_API_KEY=YOUR_API_KEY && node bundle/agent.js
```

## Configuration

Upon the first run, an `agent.json` file is created with default settings.

Key options in `agent.json`:

| Key | Description | Default |
|------|-------|---------|
| `identity` | Agent name in the terminal | `"agent"` |
| `model` | Gemini model | `"gemini-2.0-flash"` |
| `max_steps` | Max tool call loop iterations | `15` |
| `audit.show` | Show [Tool Call] / [Tool Result] | `true` |
| `mcp.servers` | List of MCP servers | `[]` |

### MCP Servers

```json
{
  "mcp": {
    "servers": [
      {
        "name": "memory",
        "cmd": "node",
        "args": ["D:\\dev\\ai\\mcp-memory-md\\bundle\\server.js"],
        "env": {}
      }
    ]
  }
}
```

## Commands

| Command | Description |
|--------|-------|
| `/help` | Help |
| `/exit` | Exit |
| `/clear` | Clear history |
| `/tools` | List MCP tools |
| `/context` | Context window usage |

## Architecture

```
src/
  agent.js        ← Main loop (readline + generateText)
  lib/
    config.js     ← Configuration loading
    mcp.js        ← MCP client (stdio JSON-RPC 2.0)
    tools.js      ← MCP ↔ ai-sdk tool() bridge + jsonSchemaToZod
    ui.js         ← Terminal output helpers
    context.js    ← Token estimation + sliding window trim
bundle/
  agent.js        ← esbuild output (executable)
```

## Key difference from google-gemini-chat

`google-gemini-chat` calls the Gemini REST API directly. This agent uses **Vercel AI SDK**:
- `generateText()` with `maxSteps` automatically handles the tool call loop.
- MCP tools are converted to ai-sdk `tool()` format with Zod schemas.
- Simpler code — the SDK handles retries, tool loops, and streaming.
