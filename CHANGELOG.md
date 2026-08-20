# Changelog

All notable changes to GossipGate are documented in this file.

## [0.2.0] — 2026-08-20

Send to named Telegram groups, channels and forum topics — not just one chat.

### Destinations

- **Named destination registry** (`destinations.json`) — messages are addressed
  by name (`target`), never by raw chat id. `chat_id` / `message_thread_id` in a
  request body are rejected with a 400
- **Forum topics** — a destination may carry a `thread_id` to post into one
  topic of a supergroup
- **Backward compatible** — `default` falls back to `TELEGRAM_CHAT_ID`, so
  callers that pass no `target` are unaffected. A missing or malformed
  `destinations.json` degrades to default-only instead of failing startup
- `GET /destinations` — names and descriptions only, never chat ids
- `SIGHUP` reloads the registry without a restart; `SIGTERM` drains the queues
  before exit

### Fixed

- **Batch mode leaked messages between destinations** — the queue was global and
  the flush sent every queued message to whichever destination came first. Queues
  are now per `provider:target` and flush independently, each in its own
  try/catch so one failing destination cannot abandon the others
- **The audit log only ever kept the day's last entry** — `Bun.write()` silently
  ignores `{ append: true }` and truncated the file on every write. Now uses
  `appendFile`
- **Batched messages lost their formatting** — queued `parse_mode` was dropped at
  flush. Digests are now deliberately plain text, with MarkdownV2 escapes and
  HTML tags normalized away; inheriting one item's `parse_mode` would make the
  others' unescaped text fail Telegram validation and lose the whole batch
- **Dropped batches and failed sends left no audit trail** — both now log
  `status: "failed"`
- **A paused service still accumulated rate** and could fire critical alerts
  about traffic it was not sending
- Error responses no longer echo raw exception strings to the client
- `Bun.serve()` now sets `maxRequestBodySize`, and `message` is capped at
  Telegram's 4096 characters

### Rate limiting

- **Per-destination soft limit** (`RATE_PER_DEST_RPM`, default 18, under
  Telegram's ~20/min per chat) escalates a single hot destination to batch mode.
  The hard limit stays global — it protects the service, and a per-target block
  tier could be evaded by rotating targets
- `/status` reports per-queue depth; `/health` reports destination count and
  config errors

### Security

- `MCP_UNAUTH_TARGETS` (default `default`) caps which destinations the
  unauthenticated `/mcp` route can reach, keeping its blast radius unchanged now
  that groups are configurable. See the Security TODO in the README

### MCP

- `send_notification` gained a `target` parameter, advertised as an enum of
  configured names. The stdio server fetches them from `GET /destinations` with
  a 2s timeout, falling back to an enum-free schema — a hung fetch during
  `tools/list` would otherwise stall the handshake and kill the tool everywhere
- The tool schema was duplicated verbatim in both transports; it now lives in
  `tool-schema.ts`

### Tests

- First test suite (`bun test`): destination resolution and validation
  (including prototype-key lookups), and batch keying, digest composition and
  plain-text normalization

## [0.1.0] — 2026-02-27

Initial release of GossipGate notification gateway.

### Core

- **HTTP API** — `POST /send` with `X-Api-Key` authentication. Accepts `message`, optional `parse_mode` (MarkdownV2/HTML), optional `provider`
- **Telegram provider** — sends messages via Telegram Bot API (`/sendMessage`). Returns `messageId` for tracking

### Rate limiting

- **Three-tier system**: soft limit (10 rpm) switches to batch mode, hard limit (50 rpm) blocks and alerts, manual pause/resume for emergencies
- **Batch mode** — collects up to 8 messages per 30-second window, consolidates into single notification to prevent channel flooding
- **Critical alert** — automatic Telegram notification when hard limit breached (5-minute cooldown between alerts)

### Audit logging

- **NDJSON format** — append-only, one file per calendar day (e.g. `2026-02-27.ndjson`)
- **Auto-rotation** — 30-day retention, old logs cleaned automatically
- **Fields**: timestamp, provider, message (truncated 500 chars), mode (direct/batch), status, messageId
- **Query API** — `GET /logs` with `date`, `from`, `to` parameters

### Admin endpoints

- `GET /health` — status + current mode (no auth)
- `GET /status` — rate stats, queue size, pause state
- `POST /pause` / `POST /resume` — emergency controls without service restart

### MCP integration

- **stdio MCP server** (`mcp/server.ts`) — exposes `send_notification` tool for Claude Code
- Supports rich Telegram formatting (MarkdownV2 + HTML)
- Auto-loads API key from `.env`

### Infrastructure

- **TypeScript + Bun** — zero external dependencies, consistent with HermesTools stack
- systemd service on port 8005 (binds `127.0.0.1` only)
- nginx gateway via `/api/gossip-gate/`
- Provider pattern — interface ready for future channels beyond Telegram
