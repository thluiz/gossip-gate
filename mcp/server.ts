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

import { buildTools } from "../tool-schema"

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

// Destination names for the `target` enum. Fetched from the gateway rather than
// read off disk: the gateway is what enforces the allowlist, and GOSSIP_GATE_URL
// may point at another host, so a local file could advertise names /send would
// then reject.
let cachedNames: string[] = []
let cachedAt = 0
const NAMES_TTL_MS = 60_000

async function fetchDestinationNames(): Promise<string[]> {
  if (Date.now() - cachedAt < NAMES_TTL_MS) return cachedNames

  try {
    const res = await fetch(`${GOSSIP_GATE_URL}/destinations`, {
      headers: { "X-Api-Key": API_KEY },
      // A hung fetch here would stall the MCP handshake and make Claude Code
      // mark the whole server dead, breaking send_notification everywhere. An
      // enum-free schema is a far cheaper failure.
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return cachedNames
    const data = (await res.json()) as { destinations?: Array<{ name: string }> }
    cachedNames = (data.destinations ?? []).map((d) => d.name)
    cachedAt = Date.now()
  } catch {
    // Gateway down or slow — keep whatever we had, possibly nothing.
  }
  return cachedNames
}

async function callSend(
  message: string,
  parse_mode?: string,
  provider?: string,
  target?: string
): Promise<{ ok: boolean; messageId: number | null; mode: string; target?: string; error?: string }> {
  const body: Record<string, string> = { message }
  if (parse_mode) body.parse_mode = parse_mode
  if (provider) body.provider = provider
  if (target) body.target = target

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
    const available = Array.isArray(data.available) ? ` Available: ${(data.available as string[]).join(", ")}.` : ""
    return {
      ok: false,
      messageId: null,
      mode: "error",
      error: String(data.error ?? "Unknown error") + available,
    }
  }
  return {
    ok: true,
    messageId: data.messageId as number | null,
    mode: data.mode as string,
    target: data.target as string | undefined,
  }
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
      serverInfo: { name: "gossip-gate", version: "0.2.0" },
    })
    return
  }

  if (method === "tools/list") {
    respond(id, { tools: buildTools(await fetchDestinationNames()) })
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
      const result = await callSend(
        toolArgs.message,
        toolArgs.parse_mode,
        toolArgs.provider,
        toolArgs.target
      )
      if (result.ok) {
        respond(id, {
          content: [
            {
              type: "text",
              text: `Notification sent to "${result.target ?? "default"}" via ${result.mode} mode. MessageId: ${result.messageId ?? "queued"}`,
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

// Requests are chained rather than awaited inline: handleRequest is async (it
// may fetch destination names), so responses must stay ordered and stdin
// closing must not exit the process while one is still in flight.
let pending: Promise<void> = Promise.resolve()

function enqueue(req: MCPRequest): void {
  pending = pending.then(() => handleRequest(req)).catch((e) => {
    console.error("[gossip-gate-mcp] handler failed:", e)
  })
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      enqueue(JSON.parse(trimmed) as MCPRequest)
    } catch {
      // ignore parse errors
    }
  }
})

process.stdin.on("end", () => {
  pending.finally(() => process.exit(0))
})
