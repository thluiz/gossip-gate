/**
 * providers/telegram.ts — Telegram Bot API provider
 */

export interface Provider {
  name: string
  send(message: string, options?: SendOptions): Promise<SendResult>
}

export interface SendOptions {
  parse_mode?: "MarkdownV2" | "HTML"
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
    const body: Record<string, string> = {
      chat_id: this.chatId,
      text: message,
    }
    if (options?.parse_mode) {
      body.parse_mode = options.parse_mode
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
