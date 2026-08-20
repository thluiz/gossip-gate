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

  constructor(token: string, chatId: string) {
    this.token = token
    this.chatId = chatId
  }

  async send(message: string, options?: SendOptions): Promise<SendResult> {
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

    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    )

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Telegram API error ${res.status}: ${err}`)
    }

    const data = (await res.json()) as { result: { message_id: number } }
    return { messageId: data.result.message_id }
  }
}
