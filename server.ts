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
import {
  DEFAULT_TARGET,
  destinationNames,
  listPublic,
  loadDestinations,
  resolveTarget,
  type Destination,
  type ResolvedDestination,
} from "./destinations"
import { composeDigest, queueKey, type QueuedMessage } from "./batch"
import { buildTools } from "./tool-schema"

// --- Config ---
const PORT = parseInt(process.env.PORT ?? "8005")
const HOST = process.env.HOST ?? "127.0.0.1"
const API_KEY = process.env.GOSSIP_API_KEY ?? ""
const RATE_SOFT_RPM = parseInt(process.env.RATE_SOFT_RPM ?? "10")
const RATE_HARD_RPM = parseInt(process.env.RATE_HARD_RPM ?? "50")
// Per-destination guard, kept under Telegram's ~20 messages/minute per chat.
const RATE_PER_DEST_RPM = parseInt(process.env.RATE_PER_DEST_RPM ?? "18")
const BATCH_WINDOW_MS = parseInt(process.env.BATCH_WINDOW_MS ?? "30000")
const BLOCK_ALERT_COOLDOWN_MS =
  parseInt(process.env.BLOCK_ALERT_COOLDOWN_MIN ?? "5") * 60 * 1000

// Destinations reachable through the UNAUTHENTICATED /mcp endpoint. That route
// self-calls /send with the master key, so without this the allowlist would let
// anything that reaches nginx post into every configured group. Default keeps
// the unauthenticated blast radius exactly what it was before this registry.
const MCP_UNAUTH_TARGETS = (process.env.MCP_UNAUTH_TARGETS ?? DEFAULT_TARGET)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// --- Providers ---
const telegram = new TelegramProvider(
  process.env.TELEGRAM_BOT_TOKEN ?? "",
  process.env.TELEGRAM_CHAT_ID ?? ""
)

const providers: Record<string, Provider> = {
  telegram,
}
const defaultProvider = "telegram"

// --- Destination registry ---
let destinations: Map<string, Destination> = new Map()
let destinationErrors: string[] = []

function reloadDestinations(): void {
  const { registry, errors } = loadDestinations()
  destinations = registry
  destinationErrors = errors
  for (const err of errors) {
    console.error(`[gossip-gate] destinations: ${err}`)
  }
  console.log(
    `[gossip-gate] ${registry.size} destination(s): ${destinationNames(registry).join(", ") || "none"}`
  )
}

reloadDestinations()

// A typo here would silently delete the alert telling you the gateway is on
// fire, so fall back to the default destination at startup instead.
let ALERT_TARGET = process.env.ALERT_TARGET?.trim() || DEFAULT_TARGET
if (!resolveTarget(destinations, ALERT_TARGET)) {
  console.error(
    `[gossip-gate] ALERT_TARGET "${ALERT_TARGET}" is not a configured destination — falling back to "${DEFAULT_TARGET}"`
  )
  ALERT_TARGET = DEFAULT_TARGET
}

// --- State ---
let paused = false
type Mode = "direct" | "batch" | "blocked"
let currentMode: Mode = "direct"

// Rate limiting: sliding window (per minute)
const requestTimestamps: number[] = []
// Per-destination windows, keyed like the batch queues.
const destTimestamps = new Map<string, number[]>()

// Batch queues — one per provider+destination. Never merged: a shared queue
// would render one group's messages into another group's digest.
const queues = new Map<string, QueuedMessage[]>()
// A single timer for every queue. One timer per key would leak timers and race
// N flushes to Telegram at once; the cost is that a queue opened late rides an
// earlier timer, which only ever makes a digest arrive sooner.
let batchTimer: ReturnType<typeof setTimeout> | null = null

// Block alert state
let blockAlertLastSent: number | null = null

// --- Rate limiter ---
function trim(list: number[], cutoff: number): void {
  while (list.length > 0 && list[0]! < cutoff) list.shift()
}

function recordRequest(key: string): void {
  const now = Date.now()
  const cutoff = now - 60_000

  requestTimestamps.push(now)
  trim(requestTimestamps, cutoff)

  let perDest = destTimestamps.get(key)
  if (!perDest) {
    perDest = []
    destTimestamps.set(key, perDest)
  }
  perDest.push(now)
  trim(perDest, cutoff)
}

function currentRpm(): number {
  const cutoff = Date.now() - 60_000
  return requestTimestamps.filter((t) => t >= cutoff).length
}

function destRpm(key: string): number {
  const cutoff = Date.now() - 60_000
  return (destTimestamps.get(key) ?? []).filter((t) => t >= cutoff).length
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

/**
 * Mode for one destination: the global mode, escalated to batch when this
 * destination alone is hot.
 *
 * The per-destination guard deliberately stops at `batch` and never reaches
 * `blocked` — blocking protects the service, and making that tier per-target
 * would let a runaway loop rotate targets to stay under every window forever.
 */
function effectiveMode(key: string): Mode {
  if (currentMode === "blocked") return "blocked"
  if (currentMode === "batch") return "batch"
  return destRpm(key) >= RATE_PER_DEST_RPM ? "batch" : "direct"
}

// --- Critical alert (bypasses everything) ---
async function sendCritical(message: string): Promise<void> {
  const to = resolveTarget(destinations, ALERT_TARGET) ?? undefined
  try {
    const result = await telegram.send(message, { to })
    await appendLog({
      ts: new Date().toISOString(),
      provider: "telegram",
      target: ALERT_TARGET,
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
function queuedTotal(): number {
  let total = 0
  for (const items of queues.values()) total += items.length
  return total
}

function scheduleBatchFlush(): void {
  if (batchTimer !== null) return
  batchTimer = setTimeout(flushAll, BATCH_WINDOW_MS)
}

async function flushOne(key: string, items: QueuedMessage[]): Promise<void> {
  const first = items[0]!
  const providerName = first.provider
  const provider = providers[providerName] ?? telegram
  const digest = composeDigest(items, BATCH_WINDOW_MS)
  const to: ResolvedDestination = { name: first.target, chat_id: first.chat_id }
  if (first.thread_id !== undefined) to.thread_id = first.thread_id

  try {
    // No parse_mode: see composeDigest.
    const result = await provider.send(digest, { to })
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      target: first.target,
      message: digest,
      mode: "batch",
      status: "batched",
      messageId: result.messageId,
    })
    for (const item of items) {
      await appendLog({
        ts: new Date().toISOString(),
        provider: item.provider,
        target: item.target,
        message: item.message,
        mode: "batch",
        status: "queued",
        messageId: null,
      })
    }
  } catch (e) {
    // /send already answered {ok:true, mode:"queued"} for these, so a silent
    // console.error would leave no trace that they were dropped.
    console.error(`[gossip-gate] Batch flush failed for ${key}:`, e)
    for (const item of items) {
      await appendLog({
        ts: new Date().toISOString(),
        provider: item.provider,
        target: item.target,
        message: item.message,
        mode: "batch",
        status: "failed",
        messageId: null,
      })
    }
  }
}

async function flushAll(): Promise<void> {
  batchTimer = null

  for (const [key, items] of [...queues.entries()]) {
    if (items.length === 0) {
      queues.delete(key)
      continue
    }
    // Splice per key inside its own try/catch: one destination throwing (bot
    // removed from the group, topic closed, chat migrated) must not abandon the
    // other queues, whose items are already out of the array.
    const batch = items.splice(0)
    await flushOne(key, batch)
    if (queues.get(key)?.length === 0) queues.delete(key)
  }

  // Anything enqueued while we were awaiting Telegram needs its own window.
  if (queuedTotal() > 0) scheduleBatchFlush()
}


// --- MCP tool definitions ---
// The schema itself lives in tool-schema.ts, shared with the stdio server in
// mcp/server.ts so the two transports cannot drift apart.
//
// This route is unauthenticated, so it only ever advertises — and only ever
// accepts — the destinations in MCP_UNAUTH_TARGETS.
function unauthTargets(): string[] {
  return MCP_UNAUTH_TARGETS.filter((name) => destinations.has(name))
}

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
        serverInfo: { name: "gossip-gate", version: "0.2.0" },
      },
    })
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204 })
  }

  if (method === "tools/list") {
    return Response.json({ jsonrpc: "2.0", id, result: { tools: buildTools(unauthTargets()) } })
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

    const target = toolArgs.target?.trim() || DEFAULT_TARGET
    if (!MCP_UNAUTH_TARGETS.includes(target)) {
      return Response.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{
            type: "text",
            text: `Refused: target "${target}" is not reachable over the unauthenticated MCP endpoint. Allowed here: ${MCP_UNAUTH_TARGETS.join(", ")}. Use the authenticated /send endpoint for other destinations.`,
          }],
          isError: true,
        },
      })
    }

    const sendBody: Record<string, string> = { message: toolArgs.message, target }
    if (toolArgs.parse_mode) sendBody.parse_mode = toolArgs.parse_mode
    if (toolArgs.provider) sendBody.provider = toolArgs.provider

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/send`, {
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
          content: [{ type: "text", text: `Notification sent to "${target}" (${data.mode}). MessageId: ${data.messageId ?? "queued"}` }],
        },
      })
    } catch (e) {
      console.error("[gossip-gate] MCP send failed:", e)
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } })
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
      destinations_loaded: destinations.size,
      destinations_errors: destinationErrors.length,
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

  if (path === "/destinations" && req.method === "GET") {
    return Response.json({
      destinations: listPublic(destinations),
      errors: destinationErrors,
    })
  }

  if (path === "/status" && req.method === "GET") {
    const perQueue: Record<string, number> = {}
    for (const [key, items] of queues) perQueue[key] = items.length

    return Response.json({
      paused,
      mode: currentMode,
      rate: {
        rpm: currentRpm(),
        soft_limit: RATE_SOFT_RPM,
        hard_limit: RATE_HARD_RPM,
        per_destination_limit: RATE_PER_DEST_RPM,
      },
      queue_size: queuedTotal(),
      queues: perQueue,
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
  let body: {
    message?: string
    provider?: string
    parse_mode?: string
    target?: string
    chat_id?: unknown
    message_thread_id?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!body.message || typeof body.message !== "string") {
    return Response.json({ error: "message is required" }, { status: 400 })
  }

  // Telegram caps text at 4096 characters — fail with a clear 400 rather than
  // relaying the provider's 502.
  if (body.message.length > 4096) {
    return Response.json({ error: "message too long (max 4096 characters)" }, { status: 400 })
  }

  // Reject rather than ignore, so callers get a clear signal and no later
  // refactor can quietly start honouring a caller-supplied chat.
  if (body.chat_id !== undefined || body.message_thread_id !== undefined) {
    return Response.json(
      { error: 'Raw chat_id is not accepted. Use "target" with a configured destination name.' },
      { status: 400 }
    )
  }

  const providerName = body.provider ?? defaultProvider
  const provider = providers[providerName]
  if (!provider) {
    return Response.json({ error: `Unknown provider: ${providerName}` }, { status: 400 })
  }

  const targetName = body.target?.trim() || DEFAULT_TARGET
  const to = resolveTarget(destinations, targetName)
  if (!to) {
    return Response.json(
      {
        error: `Unknown target: ${targetName}`,
        available: destinationNames(destinations),
      },
      { status: 400 }
    )
  }

  const options: SendOptions = { to }
  if (body.parse_mode === "MarkdownV2" || body.parse_mode === "HTML") {
    options.parse_mode = body.parse_mode
  }

  const key = queueKey(providerName, to.name)

  if (paused) {
    return Response.json({ error: "Service paused" }, { status: 503 })
  }

  recordRequest(key)
  updateMode()

  const queue = queues.get(key)
  // Drain-first: once a destination has a queue, everything for it keeps
  // queueing even after the mode relaxes. Otherwise a message queued at T could
  // be delivered after one sent directly at T+1s, breaking per-group ordering.
  const mode = queue && queue.length > 0 ? "batch" : effectiveMode(key)

  if (mode === "blocked") {
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      target: to.name,
      message: body.message,
      mode: "blocked",
      status: "blocked",
      messageId: null,
    })
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 })
  }

  if (mode === "batch") {
    const item: QueuedMessage = {
      message: body.message,
      options,
      provider: providerName,
      target: to.name,
      chat_id: to.chat_id,
    }
    if (to.thread_id !== undefined) item.thread_id = to.thread_id

    if (queue) queue.push(item)
    else queues.set(key, [item])

    scheduleBatchFlush()
    return Response.json({
      ok: true,
      provider: providerName,
      target: to.name,
      messageId: null,
      mode: "queued",
    })
  }

  // Direct send
  try {
    const result = await provider.send(body.message, options)
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      target: to.name,
      message: body.message,
      mode: "direct",
      status: "sent",
      messageId: result.messageId,
    })
    return Response.json({
      ok: true,
      provider: providerName,
      target: to.name,
      messageId: result.messageId,
      mode: "direct",
    })
  } catch (e) {
    // Details stay server-side: the exception carries the raw Telegram response.
    console.error("[gossip-gate] Send failed:", e)
    await appendLog({
      ts: new Date().toISOString(),
      provider: providerName,
      target: to.name,
      message: body.message,
      mode: "direct",
      status: "failed",
      messageId: null,
    })
    return Response.json({ error: "Send failed" }, { status: 502 })
  }
}

async function handleLogs(url: URL): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10)
  let from = url.searchParams.get("date") ?? url.searchParams.get("from") ?? today
  let to = url.searchParams.get("date") ?? url.searchParams.get("to") ?? today

  let entries = await queryLogs(from, to)

  const target = url.searchParams.get("target")
  if (target) {
    // Entries written before the registry existed have no target and were all
    // bound for the default destination.
    entries = entries.filter((e) =>
      target === DEFAULT_TARGET ? (e.target ?? DEFAULT_TARGET) === target : e.target === target
    )
  }

  return Response.json({
    entries,
    count: entries.length,
    period: { from, to },
    ...(target ? { target } : {}),
  })
}

// --- Startup ---
cleanOldLogs()

// Adding a destination is a config edit; SIGHUP avoids a restart, and queued
// items carry their resolved chat_id so a reload cannot misroute them.
process.on("SIGHUP", () => {
  console.log("[gossip-gate] SIGHUP — reloading destinations")
  reloadDestinations()
})

// systemd stop would otherwise discard the queues silently.
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  if (batchTimer !== null) clearTimeout(batchTimer)
  if (queuedTotal() > 0) {
    console.log(`[gossip-gate] draining ${queuedTotal()} queued message(s) before exit`)
    try {
      await flushAll()
    } catch (e) {
      console.error("[gossip-gate] drain on shutdown failed:", e)
    }
  }
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Bounds the request body; message length is validated in handleSend.
  maxRequestBodySize: 1024 * 1024,
  fetch: handleRequest,
})

console.log(`[gossip-gate] Listening on http://${HOST}:${PORT}`)
console.log(`[gossip-gate] Rate limits: soft=${RATE_SOFT_RPM} rpm, hard=${RATE_HARD_RPM} rpm, per-destination=${RATE_PER_DEST_RPM} rpm`)
console.log(`[gossip-gate] Unauthenticated /mcp targets: ${MCP_UNAUTH_TARGETS.join(", ")}`)
