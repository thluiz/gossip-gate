/**
 * server.ts — GossipGate notification gateway
 * Port 8005 | HermesTools
 *
 * Endpoints:
 *   POST /send       - Send notification (auth required)
 *   GET  /health     - Health check (no auth)
 *   GET  /status     - Detailed status (auth required)
 *   POST /pause      - Pause sending (auth required)
 *   POST /resume     - Resume sending (auth required)
 *   GET  /logs       - Audit log query (auth required)
 */

import { TelegramProvider, type Provider, type SendOptions } from "./providers/telegram"
import { appendLog, cleanOldLogs, queryLogs } from "./logger"

// --- Config ---
const PORT = parseInt(process.env.PORT ?? "8005")
const HOST = process.env.HOST ?? "127.0.0.1"
const API_KEY = process.env.GOSSIP_API_KEY ?? ""
const RATE_SOFT_RPM = parseInt(process.env.RATE_SOFT_RPM ?? "10")
const RATE_HARD_RPM = parseInt(process.env.RATE_HARD_RPM ?? "50")
const BATCH_WINDOW_MS = parseInt(process.env.BATCH_WINDOW_MS ?? "30000")
const BLOCK_ALERT_COOLDOWN_MS =
  parseInt(process.env.BLOCK_ALERT_COOLDOWN_MIN ?? "5") * 60 * 1000

// --- Providers ---
const telegram = new TelegramProvider(
  process.env.TELEGRAM_BOT_TOKEN ?? "",
  process.env.TELEGRAM_CHAT_ID ?? ""
)

const providers: Record<string, Provider> = {
  telegram,
}
const defaultProvider = "telegram"

// --- State ---
let paused = false
type Mode = "direct" | "batch" | "blocked"
let currentMode: Mode = "direct"

// Rate limiting: sliding window (per minute)
const requestTimestamps: number[] = []

// Batch queue
interface QueuedMessage {
  message: string
  options?: SendOptions
  provider: string
}
const batchQueue: QueuedMessage[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null

// Block alert state
let blockAlertLastSent: number | null = null

// --- Rate limiter ---
function recordRequest(): void {
  const now = Date.now()
  requestTimestamps.push(now)
  // Trim old entries
  const cutoff = now - 60_000
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < cutoff) {
    requestTimestamps.shift()
  }
}

function currentRpm(): number {
  const now = Date.now()
  const cutoff = now - 60_000
  return requestTimestamps.filter((t) => t >= cutoff).length
}

function updateMode(): void {
  const rpm = currentRpm()
  if (rpm >= RATE_HARD_RPM) {
    if (currentMode !== "blocked") {
      currentMode = "blocked"
      scheduleCriticalAlert()
    }
  } else if (rpm >= RATE_SOFT_RPM) {
    currentMode = "batch"
  } else {
    currentMode = "direct"
  }
}

// --- Critical alert (bypasses everything) ---
async function sendCritical(message: string): Promise<void> {
  try {
    const result = await telegram.send(message)
    await appendLog({
      ts: new Date().toISOString(),
      provider: "telegram",
      message,
      mode: "direct",
      status: "critical_alert",
      messageId: result.messageId,
    })
  } catch (e) {
    console.error("[gossip-gate] CRITICAL ALERT FAILED:", e)
  }
}

function scheduleCriticalAlert(): void {
  const now = Date.now()
  if (blockAlertLastSent !== null && now - blockAlertLastSent < BLOCK_ALERT_COOLDOWN_MS) {
    return
  }
  blockAlertLastSent = now

  const rpm = currentRpm()
  const msg =
    `☢️ 🚨 GOSSIPGATE BLOCK ALERT 🚨 ☢️\n\n` +
    `⛔ Hard rate limit BREACHED — all messages are being REJECTED!\n\n` +
    `📊 Rate: ${rpm} req/min  |  Limit: ${RATE_HARD_RPM} req/min\n` +
    `🕐 ${new Date().toISOString()}\n` +
    `🌐 gossip-gate @ ${HOST}:${PORT}\n\n` +
    `❗❗ Messages will resume automatically when rate drops below threshold.\n` +
    `🔧 Manual control: POST /pause or /resume`

  sendCritical(msg)
}

// Re-check for block alert every 30s
setInterval(() => {
  if (currentMode === "blocked") {
    scheduleCriticalAlert()
  }
}, 30_000)

// --- Batch flush ---
function scheduleBatchFlush(): void {
  if (batchTimer !== null) return
  batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS)
}

async function flushBatch(): Promise<void> {
  batchTimer = null
  if (batchQueue.length === 0) return

  const items = batchQueue.splice(0)
  const providerName = items[0]!.provider
  const provider = providers[providerName] ?? telegram

  const MAX_SHOWN = 8
  const shown = items.slice(0, MAX_SHOWN)
  const overflow = items.length - MAX_SHOWN

  let batchMsg =
    `[GossipGate] ${items.length} message${items.length !== 1 ? "s" : ""} in the last ${Math.round(BATCH_WINDOW_MS / 1000)}s:\n`

  for (const item of shown) {
    const truncated =
      item.message.length > 80 ? item.message.slice(0, 77) + "…" : item.message
    batchMsg += `- "${truncated}"\n`
  }
  if (overflow > 0) {
    batchMsg += `(+ ${overflow} more)`
  }

  try {
    const result = await provider.send(batchMsg)
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      message: batchMsg,
      mode: "batch",
      status: "batched",
      messageId: result.messageId,
    })
    // Log each individual queued message as "batched"
    for (const item of items) {
      await appendLog({
        ts: new Date().toISOString(),
        provider: item.provider,
        message: item.message,
        mode: "batch",
        status: "queued",
        messageId: null,
      })
    }
  } catch (e) {
    console.error("[gossip-gate] Batch flush failed:", e)
  }
}


// --- MCP Tool definitions (shared with HTTP MCP endpoint) ---
const MCP_TOOLS = [
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

// --- HTTP MCP handler (POST /mcp) ---
async function handleMcp(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
  }

  const id = body.id as number | string ?? null
  const method = body.method as string
  const params = (body.params ?? {}) as Record<string, unknown>

  if (method === "initialize") {
    return Response.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gossip-gate", version: "1.0.0" },
      },
    })
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204 })
  }

  if (method === "tools/list") {
    return Response.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } })
  }

  if (method === "tools/call") {
    const toolName = params.name as string
    const toolArgs = (params.arguments ?? {}) as Record<string, string>

    if (toolName !== "send_notification") {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } })
    }

    if (!toolArgs.message) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "message is required" } })
    }

    const sendBody: Record<string, string> = { message: toolArgs.message }
    if (toolArgs.parse_mode) sendBody.parse_mode = toolArgs.parse_mode
    if (toolArgs.provider) sendBody.provider = toolArgs.provider

    try {
      const res = await fetch("http://127.0.0.1:8005/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": API_KEY },
        body: JSON.stringify(sendBody),
      })
      const data = await res.json() as Record<string, unknown>
      if (!res.ok) {
        return Response.json({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `Failed: ${data.error}` }], isError: true },
        })
      }
      return Response.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: `Notification sent (${data.mode}). MessageId: ${data.messageId ?? "queued"}` }],
        },
      })
    } catch (e) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${e}` } })
    }
  }

  return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
}

// --- Auth middleware ---
function isAuthorized(req: Request): boolean {
  if (!API_KEY) return false
  return req.headers.get("x-api-key") === API_KEY
}

// --- Request handler ---
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // Health — no auth
  if (path === "/health" && req.method === "GET") {
    return Response.json({
      status: paused ? "paused" : "ok",
      mode: currentMode,
    })
  }


  // MCP endpoint — no auth required (trusted via nginx route)
  if (path === "/mcp" && req.method === "POST") {
    return handleMcp(req)
  }

  // All other endpoints require auth
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (path === "/send" && req.method === "POST") {
    return handleSend(req)
  }

  if (path === "/status" && req.method === "GET") {
    return Response.json({
      paused,
      mode: currentMode,
      rate: {
        rpm: currentRpm(),
        soft_limit: RATE_SOFT_RPM,
        hard_limit: RATE_HARD_RPM,
      },
      queue_size: batchQueue.length,
    })
  }

  if (path === "/pause" && req.method === "POST") {
    paused = true
    return Response.json({ paused: true })
  }

  if (path === "/resume" && req.method === "POST") {
    paused = false
    return Response.json({ paused: false })
  }

  if (path === "/logs" && req.method === "GET") {
    return handleLogs(url)
  }

  return Response.json({ error: "Not found" }, { status: 404 })
}

async function handleSend(req: Request): Promise<Response> {
  let body: { message?: string; provider?: string; parse_mode?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!body.message || typeof body.message !== "string") {
    return Response.json({ error: "message is required" }, { status: 400 })
  }

  const providerName = body.provider ?? defaultProvider
  const provider = providers[providerName]
  if (!provider) {
    return Response.json({ error: `Unknown provider: ${providerName}` }, { status: 400 })
  }

  const options: SendOptions = {}
  if (body.parse_mode === "MarkdownV2" || body.parse_mode === "HTML") {
    options.parse_mode = body.parse_mode
  }

  recordRequest()
  updateMode()

  if (paused) {
    return Response.json({ error: "Service paused" }, { status: 503 })
  }

  const mode = currentMode

  if (mode === "blocked") {
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      message: body.message,
      mode: "blocked",
      status: "blocked",
      messageId: null,
    })
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 })
  }

  if (mode === "batch") {
    batchQueue.push({ message: body.message, options, provider: providerName })
    scheduleBatchFlush()
    return Response.json({ ok: true, provider: providerName, messageId: null, mode: "queued" })
  }

  // Direct send
  try {
    const result = await provider.send(body.message, options)
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      message: body.message,
      mode: "direct",
      status: "sent",
      messageId: result.messageId,
    })
    return Response.json({ ok: true, provider: providerName, messageId: result.messageId, mode: "direct" })
  } catch (e) {
    console.error("[gossip-gate] Send failed:", e)
    return Response.json({ error: "Send failed", detail: String(e) }, { status: 502 })
  }
}

async function handleLogs(url: URL): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10)
  let from = url.searchParams.get("date") ?? url.searchParams.get("from") ?? today
  let to = url.searchParams.get("date") ?? url.searchParams.get("to") ?? today

  const entries = await queryLogs(from, to)
  return Response.json({ entries, count: entries.length, period: { from, to } })
}

// --- Startup ---
cleanOldLogs()

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: handleRequest,
})

console.log(`[gossip-gate] Listening on http://${HOST}:${PORT}`)
console.log(`[gossip-gate] Rate limits: soft=${RATE_SOFT_RPM} rpm, hard=${RATE_HARD_RPM} rpm`)
