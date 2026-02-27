# Changelog

All notable changes to GossipGate are documented in this file.

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
