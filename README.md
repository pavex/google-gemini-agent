# Gemini Agent CLI

CLI agent postavený na **Vercel AI SDK** (`ai` + `@ai-sdk/google`) s podporou MCP serverů.

## Použití

```bash
# Build
npm run build

# Spustit (API key jako argument)
node bundle/agent.js YOUR_API_KEY

# Nebo přes npm
npm run dev YOUR_API_KEY

# Alternativně přes env proměnnou
set GEMINI_API_KEY=YOUR_API_KEY && node bundle/agent.js
```

## Konfigurace

Při prvním spuštění se vytvoří `agent.json` s výchozím nastavením.

Klíčové volby v `agent.json`:

| Klíč | Popis | Default |
|------|-------|---------|
| `identity` | Jméno agenta v terminálu | `"agent"` |
| `model` | Gemini model | `"gemini-2.0-flash"` |
| `max_steps` | Max iterací tool call loop | `15` |
| `audit.show` | Zobrazovat [Tool Call] / [Tool Result] | `true` |
| `mcp.servers` | Seznam MCP serverů | `[]` |

### MCP servery

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

## Příkazy

| Příkaz | Popis |
|--------|-------|
| `/help` | Nápověda |
| `/exit` | Ukončit |
| `/clear` | Vymazat historii |
| `/tools` | Seznam MCP nástrojů |
| `/context` | Využití kontextového okna |

## Architektura

```
src/
  agent.js        ← hlavní smyčka (readline + generateText)
  lib/
    config.js     ← načítání konfigurace
    mcp.js        ← MCP klient (stdio JSON-RPC 2.0)
    tools.js      ← MCP ↔ ai-sdk tool() bridge + jsonSchemaToZod
    ui.js         ← terminal output helpers
    context.js    ← token estimace + sliding window trim
bundle/
  agent.js        ← esbuild výstup (spustitelný)
```

## Klíčový rozdíl od google-gemini-chat

`google-gemini-chat` volá Gemini REST API přímo. Tento agent používá **Vercel AI SDK**:
- `generateText()` s `maxSteps` automaticky řeší tool call smyčku
- MCP tools jsou převedeny na ai-sdk `tool()` formát s Zod schématy
- Jednodušší kód — SDK zajišťuje retry, tool loop, streaming
