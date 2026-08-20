/**
 * batch.test.ts — queue keys, digest composition, plain-text normalization
 */

import { describe, expect, test } from "bun:test"

import { composeDigest, normalizeForPlainText, queueKey, type QueuedMessage } from "./batch"

function item(message: string, target: string, parse_mode?: "MarkdownV2" | "HTML"): QueuedMessage {
  return {
    message,
    provider: "telegram",
    target,
    chat_id: target === "familia" ? "-100111" : "-100222",
    ...(parse_mode ? { options: { parse_mode } } : {}),
  }
}

describe("queueKey", () => {
  test("separates destinations", () => {
    expect(queueKey("telegram", "familia")).not.toBe(queueKey("telegram", "infra"))
  })

  test("separates providers for the same destination", () => {
    expect(queueKey("telegram", "familia")).not.toBe(queueKey("slack", "familia"))
  })

  test("is stable", () => {
    expect(queueKey("telegram", "familia")).toBe(queueKey("telegram", "familia"))
  })
})

describe("composeDigest", () => {
  test("only contains the messages it was given", () => {
    // The bug this guards: a shared queue rendered one group's messages into
    // another group's digest.
    const digest = composeDigest([item("segredo da familia", "familia")], 30_000)
    expect(digest).toContain("segredo da familia")
    expect(digest).not.toContain("infra")
  })

  test("counts and pluralizes", () => {
    expect(composeDigest([item("a", "x")], 30_000)).toContain("1 message ")
    expect(composeDigest([item("a", "x"), item("b", "x")], 30_000)).toContain("2 messages ")
  })

  test("reports the window in seconds", () => {
    expect(composeDigest([item("a", "x")], 30_000)).toContain("last 30s")
  })

  test("shows at most 8 items and counts the rest", () => {
    const items = Array.from({ length: 11 }, (_, i) => item(`msg${i}`, "x"))
    const digest = composeDigest(items, 30_000)
    expect(digest).toContain("11 messages")
    expect(digest).toContain("msg7")
    expect(digest).not.toContain("msg8")
    expect(digest).toContain("(+ 3 more)")
  })

  test("truncates long messages", () => {
    const digest = composeDigest([item("x".repeat(200), "x")], 30_000)
    expect(digest).toContain("…")
    for (const line of digest.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(90)
    }
  })

  test("collapses newlines so one item stays one line", () => {
    const digest = composeDigest([item("linha um\nlinha dois", "x")], 30_000)
    expect(digest).toContain('- "linha um linha dois"')
  })

  test("renders MarkdownV2 items without their escapes", () => {
    // The digest is sent with no parse_mode, so leftover backslashes would show.
    const digest = composeDigest([item("Deploy completed\\! Build \\#42", "x", "MarkdownV2")], 30_000)
    expect(digest).toContain("Deploy completed! Build #42")
    expect(digest).not.toContain("\\")
  })

  test("strips tags from HTML items", () => {
    const digest = composeDigest([item("<b>Alert:</b> disco cheio", "x", "HTML")], 30_000)
    expect(digest).toContain("Alert: disco cheio")
    expect(digest).not.toContain("<b>")
  })
})

describe("normalizeForPlainText", () => {
  test("leaves plain text alone", () => {
    expect(normalizeForPlainText("a - b (c)", undefined)).toBe("a - b (c)")
  })

  test("unescapes every MarkdownV2 special", () => {
    expect(normalizeForPlainText("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!", "MarkdownV2"))
      .toBe("_*[]()~`>#+-=|{}.!")
  })

  test("keeps a backslash that is not an escape", () => {
    expect(normalizeForPlainText("C:\\\\path and 50\\% ", "MarkdownV2")).toContain("\\")
  })

  test("decodes HTML entities without double-decoding", () => {
    expect(normalizeForPlainText("&amp;lt; stays", "HTML")).toBe("&lt; stays")
    expect(normalizeForPlainText("a &lt;b&gt; c", "HTML")).toBe("a <b> c")
  })

  test("turns <br> into a space", () => {
    expect(normalizeForPlainText("um<br>dois", "HTML")).toBe("um dois")
  })
})
