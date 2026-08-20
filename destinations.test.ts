/**
 * destinations.test.ts — registry loading, validation and resolution
 *
 * Must not import server.ts: it calls Bun.serve at the top level and would
 * start a real gateway on the live port.
 */

import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  DEFAULT_TARGET,
  destinationNames,
  listPublic,
  loadDestinations,
  resolveTarget,
} from "./destinations"

const dir = mkdtempSync(join(tmpdir(), "gossip-dest-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
function fixture(contents: string): string {
  const path = join(dir, `d${seq++}.json`)
  writeFileSync(path, contents)
  return path
}

function load(json: unknown, defaultChatId = "111") {
  return loadDestinations({ path: fixture(JSON.stringify(json)), defaultChatId })
}

describe("default destination", () => {
  test("is synthesized from TELEGRAM_CHAT_ID when absent", () => {
    const { registry } = load({ grupo: { chat_id: "-5076421920" } })
    expect(resolveTarget(registry, DEFAULT_TARGET)).toEqual({
      name: DEFAULT_TARGET,
      chat_id: "111",
    })
  })

  test("is used when no target is given", () => {
    const { registry } = load({})
    expect(resolveTarget(registry, undefined)?.chat_id).toBe("111")
    expect(resolveTarget(registry, "")?.chat_id).toBe("111")
    expect(resolveTarget(registry, "   ")?.chat_id).toBe("111")
  })

  test("an explicit entry wins over the env var, and says so", () => {
    const { registry, errors } = load({ default: { chat_id: "-999" } })
    expect(resolveTarget(registry, DEFAULT_TARGET)?.chat_id).toBe("-999")
    expect(errors.join()).toContain("overrides TELEGRAM_CHAT_ID")
  })

  test("is reported missing when the env var is empty too", () => {
    const { registry, errors } = load({}, "")
    expect(registry.size).toBe(0)
    expect(errors.join()).toContain("TELEGRAM_CHAT_ID is empty")
  })
})

describe("resolution", () => {
  test("returns null for an unknown alias", () => {
    const { registry } = load({ grupo: { chat_id: "-5076421920" } })
    expect(resolveTarget(registry, "nope")).toBeNull()
  })

  test("returns null for prototype keys", () => {
    // On a plain object these resolve truthy and would send chat_id: undefined.
    const { registry } = load({ grupo: { chat_id: "-5076421920" } })
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(resolveTarget(registry, key)).toBeNull()
    }
  })

  test("carries thread_id only when configured", () => {
    const { registry } = load({
      plain: { chat_id: "-100123" },
      topic: { chat_id: "-100123", thread_id: 42 },
    })
    expect(resolveTarget(registry, "plain")).toEqual({ name: "plain", chat_id: "-100123" })
    expect(resolveTarget(registry, "topic")).toEqual({
      name: "topic",
      chat_id: "-100123",
      thread_id: 42,
    })
  })
})

describe("validation", () => {
  test("rejects a bad chat_id but keeps the valid entries", () => {
    const { registry, errors } = load({
      good: { chat_id: "-5076421920" },
      bad: { chat_id: "not-an-id" },
      empty: { chat_id: "" },
      missing: { description: "no chat_id at all" },
    })
    expect(destinationNames(registry).sort()).toEqual(["default", "good"])
    expect(errors).toHaveLength(3)
  })

  test("accepts @username", () => {
    const { registry } = load({ canal: { chat_id: "@meucanal" } })
    expect(resolveTarget(registry, "canal")?.chat_id).toBe("@meucanal")
  })

  test("rejects names that would collide with the batch queue key", () => {
    const { registry, errors } = load({ "tele:gram": { chat_id: "-1" } })
    expect(resolveTarget(registry, "tele:gram")).toBeNull()
    expect(errors.join()).toContain("invalid name")
  })

  test("rejects uppercase and over-long names", () => {
    const { registry } = load({ Grupo: { chat_id: "-1" }, ["a".repeat(33)]: { chat_id: "-1" } })
    expect(destinationNames(registry)).toEqual(["default"])
  })

  test("rejects a non-positive or fractional thread_id", () => {
    const { registry, errors } = load({
      a: { chat_id: "-1", thread_id: 0 },
      b: { chat_id: "-1", thread_id: -3 },
      c: { chat_id: "-1", thread_id: 1.5 },
      d: { chat_id: "-1", thread_id: "42" },
    })
    expect(destinationNames(registry)).toEqual(["default"])
    expect(errors).toHaveLength(4)
  })

  test("skips underscore-prefixed keys without complaining", () => {
    const { registry, errors } = load({
      _comment: ["JSON has no comments"],
      grupo: { chat_id: "-5076421920" },
    })
    expect(destinationNames(registry).sort()).toEqual(["default", "grupo"])
    expect(errors).toEqual([])
  })
})

describe("failure modes stay non-fatal", () => {
  test("a missing file yields the default-only registry", () => {
    const { registry, errors } = loadDestinations({
      path: join(dir, "does-not-exist.json"),
      defaultChatId: "111",
    })
    expect(destinationNames(registry)).toEqual(["default"])
    expect(errors).toEqual([])
  })

  test("malformed JSON does not throw", () => {
    const { registry, errors } = loadDestinations({
      path: fixture("{ this is not json"),
      defaultChatId: "111",
    })
    expect(destinationNames(registry)).toEqual(["default"])
    expect(errors.join()).toContain("invalid JSON")
  })

  test("a JSON array does not throw", () => {
    const { registry, errors } = load([{ chat_id: "-1" }])
    expect(destinationNames(registry)).toEqual(["default"])
    expect(errors.join()).toContain("expected a JSON object")
  })
})

describe("listPublic", () => {
  test("never exposes chat_id or thread_id", () => {
    const { registry } = load({ topic: { chat_id: "-100123", thread_id: 42, description: "d" } })
    const listed = listPublic(registry)
    expect(JSON.stringify(listed)).not.toContain("-100123")
    expect(JSON.stringify(listed)).not.toContain("42")
    expect(listed).toContainEqual({ name: "topic", description: "d", has_topic: true })
  })
})
