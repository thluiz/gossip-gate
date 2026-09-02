/**
 * telegram.test.ts — bot selection and token redaction
 *
 * Both concerns are one-line mistakes with expensive consequences: posting as
 * the wrong bot, or writing a bot token into the journal. Neither is visible in
 * normal operation, so they are pinned here.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { TelegramProvider } from "./telegram"

const DEFAULT_TOKEN = "111111:AAdefaultdefaultdefaultdefault"
const JACI_TOKEN = "222222:AAjacijacijacijacijacijacijaci"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Captures the request instead of sending it, and answers like the Bot API. */
function stubFetch(): { urls: string[]; bodies: Record<string, unknown>[] } {
  const urls: string[] = []
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url))
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
  }) as unknown as typeof fetch

  return { urls, bodies }
}

function provider() {
  return new TelegramProvider(
    DEFAULT_TOKEN,
    "-100default",
    new Map([["jaci", JACI_TOKEN]])
  )
}

describe("bot selection", () => {
  test("a destination with a bot posts with that bot's token", async () => {
    const calls = stubFetch()
    await provider().send("oi", { to: { name: "oficina", chat_id: "-536", bot: "jaci" } })
    expect(calls.urls[0]).toContain(JACI_TOKEN)
    expect(calls.urls[0]).not.toContain(DEFAULT_TOKEN)
    expect(calls.bodies[0]!.chat_id).toBe("-536")
  })

  test("a destination without a bot uses the default token", async () => {
    const calls = stubFetch()
    await provider().send("oi", { to: { name: "grupo", chat_id: "-1" } })
    expect(calls.urls[0]).toContain(DEFAULT_TOKEN)
  })

  test("no destination at all still uses the default token and chat", async () => {
    const calls = stubFetch()
    await provider().send("oi")
    expect(calls.urls[0]).toContain(DEFAULT_TOKEN)
    expect(calls.bodies[0]!.chat_id).toBe("-100default")
  })

  test("an unknown bot name falls back to the default rather than dropping the message", async () => {
    const calls = stubFetch()
    await provider().send("oi", { to: { name: "x", chat_id: "-1", bot: "inexistente" } })
    expect(calls.urls[0]).toContain(DEFAULT_TOKEN)
  })

  test("thread_id and parse_mode still travel", async () => {
    const calls = stubFetch()
    await provider().send("oi", {
      parse_mode: "HTML",
      to: { name: "t", chat_id: "-1", thread_id: 42, bot: "jaci" },
    })
    expect(calls.bodies[0]!.message_thread_id).toBe(42)
    expect(calls.bodies[0]!.parse_mode).toBe("HTML")
  })

  test("botNames and hasBot report what was loaded", () => {
    expect(provider().botNames()).toEqual(["jaci"])
    expect(provider().hasBot("jaci")).toBe(true)
    expect(provider().hasBot("nope")).toBe(false)
  })
})

describe("redaction", () => {
  test("an API error scrubs the token that was used", async () => {
    globalThis.fetch = (async () =>
      new Response(`{"description":"bot ${JACI_TOKEN} is not a member"}`, {
        status: 403,
      })) as unknown as typeof fetch

    const err = await provider()
      .send("oi", { to: { name: "oficina", chat_id: "-536", bot: "jaci" } })
      .catch((e: Error) => e)

    expect(String(err)).toContain("<redacted>")
    expect(String(err)).not.toContain(JACI_TOKEN)
  })

  test("scrubs every loaded token, not only the one in use", async () => {
    // The regression this exists for: redacting only the default token would
    // print another bot's token the first time that bot got a 403.
    globalThis.fetch = (async () =>
      new Response(`leak: ${DEFAULT_TOKEN} and ${JACI_TOKEN}`, { status: 400 })) as unknown as typeof fetch

    const err = await provider()
      .send("oi", { to: { name: "grupo", chat_id: "-1" } })
      .catch((e: Error) => e)

    expect(String(err)).not.toContain(JACI_TOKEN)
    expect(String(err)).not.toContain(DEFAULT_TOKEN)
  })

  test("a transport failure scrubs the token out of the URL", async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${JACI_TOKEN}/sendMessage`)
    }) as unknown as typeof fetch

    const err = await provider()
      .send("oi", { to: { name: "oficina", chat_id: "-536", bot: "jaci" } })
      .catch((e: Error) => e)

    expect(String(err)).not.toContain(JACI_TOKEN)
    expect(String(err)).toContain("<redacted>")
  })
})
