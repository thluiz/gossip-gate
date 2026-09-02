/**
 * providers/telegram.ts — Telegram Bot API provider
 */

import type { ResolvedDestination } from "../destinations"

export interface Provider {
  name: string
  send(message: string, options?: SendOptions): Promise<SendResult>
}

export interface SendOptions {
  parse_mode?: "MarkdownV2" | "HTML"
  /**
   * Destination for this message. Typed as ResolvedDestination — which only
   * destinations.resolveTarget() constructs — so a chat_id can never reach the
   * Bot API without having passed the allowlist.
   */
  to?: ResolvedDestination
}

export interface SendResult {
  messageId: number
}

export class TelegramProvider implements Provider {
  name = "telegram"

  private readonly token: string
  private readonly chatId: string
  /** Extra bots, by name. A destination picks one; everything else uses the default. */
  private readonly bots: Map<string, string>

  constructor(token: string, chatId: string, bots?: Map<string, string>) {
    this.token = token
    this.chatId = chatId
    this.bots = bots ?? new Map()
  }

  /** Bot names available besides the default one. */
  botNames(): string[] {
    return [...this.bots.keys()]
  }

  hasBot(name: string): boolean {
    return this.bots.has(name)
  }

  async send(message: string, options?: SendOptions): Promise<SendResult> {
    // An unknown bot falls back to the default one rather than throwing: the
    // registry is validated at load time, so reaching here with an unknown name
    // means a message would otherwise be dropped for a config problem already
    // reported at startup.
    const token = (options?.to?.bot && this.bots.get(options.to.bot)) || this.token

    // The constructor chatId stays as the fallback so callers predating the
    // destination registry keep working untouched.
    const body: Record<string, string | number> = {
      chat_id: options?.to?.chat_id ?? this.chatId,
      text: message,
    }
    if (options?.parse_mode) {
      body.parse_mode = options.parse_mode
    }
    if (options?.to?.thread_id !== undefined) {
      // Forum supergroups only; the Bot API wants a number here.
      body.message_thread_id = options.to.thread_id
    }

    let res: Response
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (e) {
      // A fetch failure (DNS, connection refused) carries the request URL on the
      // error object, and that URL contains the bot token — logging the raw
      // error writes the token to the journal in clear text. Rethrow a plain
      // Error so only the scrubbed message survives.
      throw new Error(`Telegram request failed: ${this.redact(asMessage(e))}`)
    }

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Telegram API error ${res.status}: ${this.redact(err)}`)
    }

    const data = (await res.json()) as { result: { message_id: number } }
    return { messageId: data.result.message_id }
  }

  /**
   * Scrubs every token, not just the one used for this call. A failed fetch
   * carries the request URL, and the URL carries the token; with several bots
   * loaded, redacting only the default would print another bot's token into the
   * journal the first time that bot got a 403.
   */
  private redact(text: string): string {
    let out = text
    for (const token of [this.token, ...this.bots.values()]) {
      if (token) out = out.split(token).join("<redacted>")
    }
    return out
  }
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
