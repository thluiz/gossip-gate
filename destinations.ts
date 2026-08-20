/**
 * destinations.ts — Named destination registry (allowlist)
 *
 * Callers pick a destination by alias; raw chat_ids are never accepted from
 * request input. Pure module — no side effects at import time, so it can be
 * unit tested without starting the gateway.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

export interface Destination {
  name: string
  chat_id: string
  thread_id?: number
  description?: string
}

/**
 * A destination that has been through resolveTarget(). Only this module
 * constructs it, which is what makes the allowlist structural: no other code
 * path can hand an arbitrary chat_id to a provider.
 */
export interface ResolvedDestination {
  name: string
  chat_id: string
  thread_id?: number
}

export interface LoadResult {
  registry: Map<string, Destination>
  /** Config problems to surface at startup. Never fatal. */
  errors: string[]
}

export const DEFAULT_TARGET = "default"

// ':' in particular must stay out — the batch queue key is `provider:target`,
// so an alias containing ':' could collide across keys.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CHAT_ID_RE = /^(-?\d+|@[A-Za-z0-9_]{4,31})$/

function defaultPath(): string {
  return process.env.GOSSIP_DESTINATIONS_PATH || join(import.meta.dir, "destinations.json")
}

function validateEntry(name: string, value: unknown, errors: string[]): Destination | null {
  if (!NAME_RE.test(name)) {
    errors.push(`destination "${name}": invalid name, must match ${NAME_RE.source}`)
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`destination "${name}": expected an object`)
    return null
  }

  const raw = value as Record<string, unknown>
  const chatId = typeof raw.chat_id === "string" ? raw.chat_id.trim() : ""
  if (!CHAT_ID_RE.test(chatId)) {
    errors.push(`destination "${name}": chat_id must be a numeric id or @username`)
    return null
  }

  const dest: Destination = { name, chat_id: chatId }

  if (raw.thread_id !== undefined) {
    const t = raw.thread_id
    if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) {
      errors.push(`destination "${name}": thread_id must be a positive integer`)
      return null
    }
    dest.thread_id = t
  }

  if (typeof raw.description === "string") dest.description = raw.description

  return dest
}

/**
 * Reads the registry from disk. A missing file is normal, not an error, and a
 * malformed one degrades to the default-only registry — throwing here would put
 * systemd in a restart loop and take down every notification path at once.
 */
export function loadDestinations(opts?: { path?: string; defaultChatId?: string }): LoadResult {
  const path = opts?.path ?? defaultPath()
  const defaultChatId = (opts?.defaultChatId ?? process.env.TELEGRAM_CHAT_ID ?? "").trim()
  const registry = new Map<string, Destination>()
  const errors: string[] = []

  if (existsSync(path)) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"))
    } catch (e) {
      errors.push(`${path}: invalid JSON (${(e as Error).message}) — file ignored`)
    }

    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      errors.push(`${path}: expected a JSON object of {name: destination}`)
      parsed = null
    }

    if (parsed !== null) {
      // Object.entries never walks the prototype chain, unlike for..in.
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        // JSON has no comments; a leading underscore is the usual stand-in and
        // the shipped example uses one. Skip quietly rather than warn.
        if (name.startsWith("_")) continue
        const entry = validateEntry(name, value, errors)
        if (entry) registry.set(name, entry)
      }
    }
  }

  // Backward compat: without an explicit `default`, the historical
  // TELEGRAM_CHAT_ID is the default destination, so callers that never pass a
  // target behave exactly as they did before this registry existed.
  const explicitDefault = registry.get(DEFAULT_TARGET)
  if (!explicitDefault) {
    if (defaultChatId) {
      registry.set(DEFAULT_TARGET, {
        name: DEFAULT_TARGET,
        chat_id: defaultChatId,
        description: "default channel (TELEGRAM_CHAT_ID)",
      })
    } else {
      errors.push(`no "${DEFAULT_TARGET}" destination configured and TELEGRAM_CHAT_ID is empty`)
    }
  } else if (defaultChatId && explicitDefault.chat_id !== defaultChatId) {
    errors.push(`"${DEFAULT_TARGET}" from ${path} overrides TELEGRAM_CHAT_ID`)
  }

  return { registry, errors }
}

export function resolveTarget(
  registry: Map<string, Destination>,
  name?: string | null
): ResolvedDestination | null {
  const key = (name ?? "").trim() || DEFAULT_TARGET

  // Map lookup, so "__proto__" and "constructor" miss like any other unknown
  // alias. On a plain object they would resolve truthy and send with an
  // undefined chat_id.
  const dest = registry.get(key)
  if (!dest) return null

  return dest.thread_id !== undefined
    ? { name: dest.name, chat_id: dest.chat_id, thread_id: dest.thread_id }
    : { name: dest.name, chat_id: dest.chat_id }
}

export function destinationNames(registry: Map<string, Destination>): string[] {
  return [...registry.keys()]
}

/**
 * Safe to hand to a client: names and descriptions only. Returning chat_ids
 * here would turn the gateway into the chat-id oracle we deliberately did not
 * build.
 */
export function listPublic(
  registry: Map<string, Destination>
): Array<{ name: string; description: string | null; has_topic: boolean }> {
  return [...registry.values()].map((d) => ({
    name: d.name,
    description: d.description ?? null,
    has_topic: d.thread_id !== undefined,
  }))
}
