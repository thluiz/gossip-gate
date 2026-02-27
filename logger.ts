/**
 * logger.ts — Audit log: NDJSON append-only, one file per day
 */

import { join } from "path"
import { existsSync, readdirSync, unlinkSync, mkdirSync } from "fs"

export interface LogEntry {
  ts: string
  provider: string
  message: string
  mode: "direct" | "batch" | "blocked"
  status: "sent" | "queued" | "batched" | "blocked" | "critical_alert"
  messageId: number | null
}

const LOG_DIR = join(import.meta.dir, "logs")
const MAX_MSG_LEN = parseInt(process.env.LOG_MAX_MSG_LEN ?? "500")
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? "30")

let lastCleanupDate = ""

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function logFilePath(date: string): string {
  return join(LOG_DIR, `${date}.ndjson`)
}

export async function appendLog(entry: LogEntry): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true })

  const today = todayStr()

  // Lazy daily cleanup
  if (lastCleanupDate !== today) {
    lastCleanupDate = today
    cleanOldLogs()
  }

  const truncated = entry.message.length > MAX_MSG_LEN
    ? entry.message.slice(0, MAX_MSG_LEN) + "…"
    : entry.message

  const line = JSON.stringify({ ...entry, message: truncated }) + "\n"
  await Bun.write(Bun.file(logFilePath(today)), line, { append: true } as any)
}

export function cleanOldLogs(): void {
  if (!existsSync(LOG_DIR)) return
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  try {
    for (const file of readdirSync(LOG_DIR)) {
      if (!file.endsWith(".ndjson")) continue
      const dateStr = file.replace(".ndjson", "")
      const fileMs = new Date(dateStr).getTime()
      if (!isNaN(fileMs) && fileMs < cutoff) {
        unlinkSync(join(LOG_DIR, file))
      }
    }
  } catch {
    // non-fatal
  }
}

export async function queryLogs(from: string, to: string): Promise<LogEntry[]> {
  if (!existsSync(LOG_DIR)) return []
  const entries: LogEntry[] = []
  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()

  for (const file of readdirSync(LOG_DIR).sort()) {
    if (!file.endsWith(".ndjson")) continue
    const dateStr = file.replace(".ndjson", "")
    const fileMs = new Date(dateStr).getTime()
    if (isNaN(fileMs) || fileMs < fromMs || fileMs > toMs) continue

    const content = await Bun.file(join(LOG_DIR, file)).text()
    for (const line of content.split("\n")) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as LogEntry)
      } catch {
        // skip malformed
      }
    }
  }
  return entries
}
