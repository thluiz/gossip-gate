# GossipGate

Lightweight notification gateway with a provider pattern. Send messages to Telegram (and future channels) via a simple authenticated REST API.

## What is GossipGate

GossipGate is a Bun microservice that:
- Accepts `POST /send` with a message and optional formatting options
- Routes to the configured provider (currently Telegram)
- Automatically batches messages when traffic spikes (soft rate limit)
- Blocks and alerts on DDoS-level traffic (hard rate limit)
- Logs all activity as NDJSON (one file per day, auto-rotated)
- Exposes an MCP stdio server for native Claude Code integration

## Why Bun

Zero-config TypeScript runtime, consistent with the HermesTools service stack.

## Why API key in header

Sufficient for an internal-network service. The key is stored at a filesystem path only you control — no secrets in URLs or environment leakage.

## Why layered rate limiting

- **Soft limit (batch mode):** Prevents channel flooding during bursts while preserving all message content
- **Hard limit (block mode):** Rejects requests during DDoS-level traffic and fires an automatic critical alert
- **Manual pause:** Emergency stop without service restart

## Why batch mode

Avoids Telegram spam during bursts while keeping all information. Future enhancement: pass queued messages to vox-intelligence for LLM summarization before forwarding.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Generate a random API key: `uuidgen` or `python3 -c "import uuid; print(uuid.uuid4())"`
3. Store the key where your clients can read it (e.g. `~/.gossipgate/api-key`)
4. Enable the systemd service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable gossip-gate
   sudo systemctl start gossip-gate
   ```

## API Reference

### POST /send

Send a notification.

```bash
curl -X POST http://localhost:8005/send \
  -H "X-Api-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!", "parse_mode": "MarkdownV2"}'
```

Body:
- `message` (required): Message text
- `provider` (optional): Target provider (default: `telegram`)
- `parse_mode` (optional): `"MarkdownV2"` or `"HTML"` for rich formatting

Response:
```json
{"ok": true, "provider": "telegram", "messageId": 123, "mode": "direct"}
```

### GET /health

Health check, no auth required.

```json
{"status": "ok", "mode": "direct"}
```

### GET /status

Detailed rate and queue status.

```json
{
  "paused": false,
  "mode": "direct",
  "rate": {"rpm": 2, "soft_limit": 10, "hard_limit": 50},
  "queue_size": 0
}
```

### POST /pause / POST /resume

Admin control to disable/enable sending without restarting.

### GET /logs

Query audit logs.

```
GET /logs                          # today
GET /logs?date=2026-02-27         # specific day
GET /logs?from=2026-02-01&to=2026-02-27  # date range
```

## MCP Integration (Claude Code)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "gossip-gate": {
      "command": "wsl",
      "args": ["-d", "HermesTools", "-u", "hermes", "--", "/home/hermes/.bun/bin/bun", "run", "/home/hermes/services/gossip-gate/mcp/server.ts"],
      "env": {"GOSSIP_GATE_URL": "http://127.0.0.1:8005"}
    }
  }
}
```

## Adding Providers

Implement the `Provider` interface from `providers/telegram.ts`:

```typescript
interface Provider {
  name: string
  send(message: string, options?: SendOptions): Promise<{ messageId: number }>
}
```

Register in `server.ts` under the `providers` map.

## Security TODO

- [ ] **MCP auth bypass** — `/mcp` endpoint has no authentication and self-calls `/send` with the master API key (`server.ts:285-334`). Any localhost process can send Telegram notifications without credentials. Fix: add auth to `/mcp` or refactor `handleMcp` to call `handleSend` in-process.
- [ ] **Error messages leak internals** — catch blocks return raw exception strings that may include Telegram bot token or stack traces (`server.ts:304,439`). Fix: return generic error to client, log details server-side.
- [ ] **Non-constant-time API key comparison** — `===` instead of `crypto.timingSafeEqual()` (`server.ts:314`).
- [ ] **No request body size limit** — `Bun.serve()` called without `maxRequestBodySize`. Add limit + validate `message.length`.
