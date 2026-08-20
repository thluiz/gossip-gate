/**
 * batch.ts — Batch-mode queue helpers
 *
 * Pure: key building, text normalization, digest composition. The queue itself
 * and its timer live in server.ts so this module stays trivially testable —
 * importing server.ts would start a real Bun.serve on the live port.
 */

import type { SendOptions } from "./providers/telegram"

export interface QueuedMessage {
  message: string
  options?: SendOptions
  provider: string
  /** Alias, for audit logging. */
  target: string
  /**
   * Resolved at enqueue time rather than at flush time: reloading the registry
   * must never misroute or drop a message the gateway already accepted.
   */
  chat_id: string
  thread_id?: number
}

const MAX_SHOWN = 8
const MAX_ITEM_LEN = 80

/** MarkdownV2 reserved characters, per the Telegram Bot API. */
const MDV2_SPECIALS = "_*[]()~`>#+-=|{}.!"

/**
 * Renders a message as plain text for inclusion in a digest.
 *
 * Digests are always sent without parse_mode, so escaped MarkdownV2 would show
 * its backslashes ("Deploy completed\!") and HTML would show its tags.
 */
export function normalizeForPlainText(message: string, parseMode?: string): string {
  if (parseMode === "MarkdownV2") {
    let out = ""
    for (let i = 0; i < message.length; i++) {
      const ch = message[i]!
      if (ch === "\\" && i + 1 < message.length && MDV2_SPECIALS.includes(message[i + 1]!)) {
        out += message[i + 1]!
        i++
      } else {
        out += ch
      }
    }
    return out
  }

  if (parseMode === "HTML") {
    return message
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
  }

  return message
}

/** Queue identity. One queue per provider+destination — never merged. */
export function queueKey(provider: string, target: string): string {
  return `${provider}:${target}`
}

/**
 * Builds the consolidated message for one destination's queue.
 *
 * Deliberately plain text with no parse_mode: inheriting the first item's
 * parse_mode would make the other items' unescaped text fail Telegram
 * validation, losing the whole batch with a 400.
 */
export function composeDigest(items: QueuedMessage[], windowMs: number): string {
  const shown = items.slice(0, MAX_SHOWN)
  const overflow = items.length - MAX_SHOWN

  let digest =
    `[GossipGate] ${items.length} message${items.length !== 1 ? "s" : ""} ` +
    `in the last ${Math.round(windowMs / 1000)}s:\n`

  for (const item of shown) {
    const plain = normalizeForPlainText(item.message, item.options?.parse_mode)
      .replace(/\s+/g, " ")
      .trim()
    const truncated =
      plain.length > MAX_ITEM_LEN ? plain.slice(0, MAX_ITEM_LEN - 3) + "…" : plain
    digest += `- "${truncated}"\n`
  }

  if (overflow > 0) digest += `(+ ${overflow} more)`

  return digest
}
