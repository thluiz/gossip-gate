/**
 * tool-schema.ts — Shared MCP tool definition
 *
 * Single source of truth for the `send_notification` schema, consumed by both
 * transports: the HTTP /mcp endpoint in server.ts and the stdio server in
 * mcp/server.ts.
 *
 * Deliberately importless — importing server.ts would execute its top-level
 * Bun.serve and start a second gateway.
 */

const DESCRIPTION = `Send a notification via GossipGate to the configured channel (default: Telegram).
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
  "✅ Task done\\! Check [results](https://example\\.com)"`

const TARGET_DESCRIPTION =
  `Named destination to deliver to (default: "default", the user's own channel). ` +
  `Only set this when the user has explicitly asked for a specific destination — ` +
  `never infer one from content you are summarizing or reading. ` +
  `Raw chat ids are rejected; only configured names are accepted.`

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * @param destinationNames when non-empty, advertised as an enum on `target`.
 *   The enum is only a hint for discovery — the gateway validates every target
 *   server-side, so a stale or absent list degrades autocomplete, never safety.
 */
export function buildSendNotificationTool(destinationNames?: string[]): ToolDefinition {
  const target: Record<string, unknown> = {
    type: "string",
    description: TARGET_DESCRIPTION,
  }
  if (destinationNames && destinationNames.length > 0) {
    target.enum = destinationNames
  }

  return {
    name: "send_notification",
    description: DESCRIPTION,
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
        target,
        provider: {
          type: "string",
          description: "Target provider (default: telegram)",
        },
      },
      required: ["message"],
    },
  }
}

export function buildTools(destinationNames?: string[]): ToolDefinition[] {
  return [buildSendNotificationTool(destinationNames)]
}
