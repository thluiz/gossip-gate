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
- `message` (required): Message text (max 4096 characters)
- `target` (optional): Named destination (default: `default`). See [Destinations](#destinations)
- `provider` (optional): Target provider (default: `telegram`)
- `parse_mode` (optional): `"MarkdownV2"` or `"HTML"` for rich formatting

Raw `chat_id` / `message_thread_id` are rejected with a 400 — destinations are
addressed by name only.

Response:
```json
{"ok": true, "provider": "telegram", "target": "default", "messageId": 123, "mode": "direct"}
```

### GET /destinations

List configured destination names. Returns names and descriptions only, never
chat ids.

```json
{
  "destinations": [
    {"name": "default", "description": "default channel (TELEGRAM_CHAT_ID)", "has_topic": false},
    {"name": "alertas-infra", "description": "infra alerts supergroup", "has_topic": false}
  ],
  "errors": []
}
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
GET /logs?target=alertas-infra    # one destination
```

## Destinations

Messages are addressed by **name**, never by raw chat id. Names are configured
in `destinations.json` (gitignored — copy `destinations.example.json`):

```json
{
  "alertas-infra": { "chat_id": "-1001234567890", "description": "infra alerts" },
  "deploys":       { "chat_id": "-1001234567890", "thread_id": 42, "description": "Deploys topic" }
}
```

- `default` is optional. Without it, `TELEGRAM_CHAT_ID` is the default
  destination, so callers that pass no `target` behave exactly as they always
  have.
- Names must match `^[a-z0-9][a-z0-9_-]{0,31}$`.
- `thread_id` targets a single topic inside a forum supergroup.
- `bot` picks which bot posts, by name: the token comes from
  `TELEGRAM_BOT_TOKEN_<NAME>` in the environment, never from this file. Without
  it, the default bot posts. Use it when the chat already belongs to another bot
  — adding the default bot to that group instead would widen what it can read.
  A destination naming a bot with no token loaded is reported in
  `destinations_errors` and falls back to the default bot.
- An invalid entry is skipped with a log line; it never stops the service.
  Check `GET /destinations` or `GET /health` (`destinations_errors`).
- `SIGHUP` (`systemctl reload`) re-reads the file without a restart.

### Adding a group

1. **Add the bot to the group.** Sending only needs plain membership — privacy
   mode affects what the bot *reads*, not what it posts. In a **channel** the
   bot must be an administrator with permission to post.
2. **Get the real chat id.** A bot that is not a member gets
   `Bad Request: chat not found`, and so does a wrong id — the two failures look
   identical, so confirm with:
   ```bash
   curl -s -d chat_id=-5076421920 https://api.telegram.org/bot$TOKEN/getChat
   ```
3. **Mind the `-100` prefix.** Basic groups have ids like `-5076421920`.
   Supergroups and channels carry a `-100` prefix (`-1001234567890`). Read the
   real id rather than adding the prefix yourself — and note that promoting a
   group to a supergroup **changes its id**, which breaks the destination until
   you update it.

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

`options.to` carries the resolved destination (`chat_id`, optional `thread_id`).
Its type is only constructible by `destinations.resolveTarget()`, which is what
keeps the allowlist structural rather than a convention.

## Security TODO

- [ ] **MCP auth bypass** — the `/mcp` endpoint has no authentication and
  self-calls `/send` with the master API key. It is excluded from the
  internet-facing nginx listener on purpose, but still reachable without
  credentials on the internal listeners, which bind `0.0.0.0`.
  **Partially mitigated:** `MCP_UNAUTH_TARGETS` (default `default`) caps which
  destinations that route can reach, so adding groups does not widen the
  unauthenticated blast radius. Naming a destination is still not the same as
  being authorized to use it — anything that reaches `/mcp` can post to every
  target on that list. Real fix: authenticate `/mcp`, or have `handleMcp` call
  `handleSend` in-process instead of re-entering over HTTP with the master key.
- [ ] **Prompt injection has a menu now** — a Claude session summarizing
  untrusted content can be steered into calling `send_notification` with a group
  `target`. No fix inside the service; compensating controls are the tool
  description (only set `target` when the user named one), the audit log's
  `target` field, and `GET /logs?target=`.
- [ ] **Non-constant-time API key comparison** — `===` instead of
  `crypto.timingSafeEqual()`.
- [x] **Error messages leak internals** — `/send` and `/mcp` now return generic
  errors; details go to the server log. The bot token is scrubbed from provider
  errors before they get there: a failed `fetch` carries the request URL, which
  embeds the token, so logging the raw error wrote it to the journal in clear
  text. **Any token used before this fix should be rotated** — journal entries
  from failed sends still contain it.
- [x] **No request body size limit** — `Bun.serve()` sets `maxRequestBodySize`,
  and `message.length` is capped at Telegram's 4096.
