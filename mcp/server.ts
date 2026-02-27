/**
 * mcp/server.ts — GossipGate MCP stdio server
 *
 * Lightweight MCP wrapper that exposes send_notification tool.
 * Reads API key from /home/hermes/services/gossip-gate/.env
 * or from GOSSIP_API_KEY env var.
 * POSTs to localhost:8005/send.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

const GOSSIP_GATE_URL = process.env.GOSSIP_GATE_URL ?? "http://127.0.0.1:8005"

// Load API key from .env if not in environment
function loadApiKey(): string {
  if (process.env.GOSSIP_API_KEY) return process.env.GOSSIP_API_KEY

  const envPath = join(import.meta.dir, "..", ".env")
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8")
    for (const line of content.split("\n")) {
      const m = line.match(/^GOSSIP_API_KEY=(.+)$/)
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, "")
    }
  }

  return ""
}

const API_KEY = loadApiKey()

// MCP protocol types
interface MCPRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

interface MCPResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const TOOLS = [
  {
    name: "send_notification",
    description: `Send a notification via GossipGate to the configured channel (default: Telegram).
Supports rich Telegram formatting — PREFER formatted messages over boring plain text!

FORMATTING OPTIONS (parse_mode: "MarkdownV2"):
  *bold text*          → bold
  _italic text_        → italic
  \`inline code\`       → monospace
  \`\`\`language         → code block
  code here
  \`\`\`
  [link text](url)     → hyperlink
  ||spoiler text||     → spoiler

IMPORTANT: In MarkdownV2, these chars MUST be escaped with \\:
  . ! - + = | { } ( ) # > ~ [ ]

EXAMPLES of good messages:
  "🚀 *Deploy completed\\!* Build \`#42\` is live\\."
  "⚠️ *Alert:* Service \`whisper\\-api\` is _unresponsive_\\."
  "✅ Task done\\! Check [results](https://example\\.com)"`,
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message content (plain text or formatted)",
        },
        parse_mode: {
          type: "string",
          enum: ["MarkdownV2", "HTML"],
          description: "Telegram formatting mode. Use MarkdownV2 for rich messages.",
        },
        provider: {
          type: "string",
          description: "Target provider (default: telegram)",
        },
      },
      required: ["message"],
    },
  },
]

async function callSend(
  message: string,
  parse_mode?: string,
  provider?: string
): Promise<{ ok: boolean; messageId: number | null; mode: string; error?: string }> {
  const body: Record<string, string> = { message }
  if (parse_mode) body.parse_mode = parse_mode
  if (provider) body.provider = provider

  const res = await fetch(`${GOSSIP_GATE_URL}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY,
    },
    body: JSON.stringify(body),
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok) {
    return { ok: false, messageId: null, mode: "error", error: String(data.error ?? "Unknown error") }
  }
  return { ok: true, messageId: data.messageId as number | null, mode: data.mode as string }
}

function respond(id: number | string, result: unknown): void {
  const msg: MCPResponse = { jsonrpc: "2.0", id, result }
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function respondError(id: number | string, code: number, message: string): void {
  const msg: MCPResponse = { jsonrpc: "2.0", id, error: { code, message } }
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function handleRequest(req: MCPRequest): Promise<void> {
  const { id, method, params } = req

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "gossip-gate", version: "1.0.0" },
    })
    return
  }

  if (method === "tools/list") {
    respond(id, { tools: TOOLS })
    return
  }

  if (method === "tools/call") {
    const toolName = params?.name as string
    const toolArgs = (params?.arguments ?? {}) as Record<string, string>

    if (toolName !== "send_notification") {
      respondError(id, -32601, `Unknown tool: ${toolName}`)
      return
    }

    if (!toolArgs.message) {
      respondError(id, -32602, "message is required")
      return
    }

    try {
      const result = await callSend(toolArgs.message, toolArgs.parse_mode, toolArgs.provider)
      if (result.ok) {
        respond(id, {
          content: [
            {
              type: "text",
              text: `Notification sent via ${result.mode} mode. MessageId: ${result.messageId ?? "queued"}`,
            },
          ],
        })
      } else {
        respond(id, {
          content: [{ type: "text", text: `Failed: ${result.error}` }],
          isError: true,
        })
      }
    } catch (e) {
      respondError(id, -32603, `Internal error: ${String(e)}`)
    }
    return
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return
  }

  respondError(id, -32601, `Method not found: ${method}`)
}

// stdin line-by-line reader
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const req = JSON.parse(trimmed) as MCPRequest
      await handleRequest(req)
    } catch {
      // ignore parse errors
    }
  }
})

process.stdin.on("end", () => process.exit(0))
