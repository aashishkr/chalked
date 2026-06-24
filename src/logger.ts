/**
 * logger.ts — lightweight local error logger for Excalidraw Desktop
 *
 * Usage:
 *   import { logger } from "./logger";
 *   logger.init(appDataDir);   // call once on app start
 *   logger.error("msg", err);
 *   logger.warn("msg", { context });
 *   logger.info("msg");
 *
 * Log files land at:
 *   ~/Library/Application Support/com.excalidraw.desktop/logs/app-YYYY-MM-DD.log
 * Each line is a JSON object. Files rotate at 5 MB.
 */

import { writeTextFile, readTextFile, exists, mkdir, stat, rename } from "@tauri-apps/plugin-fs";

// ─── Types ────────────────────────────────────────────────────────────────────

type Level = "error" | "warn" | "info";

interface LogEntry {
  ts: string;       // ISO timestamp
  level: Level;
  msg: string;
  stack?: string;
  ctx?: unknown;
}

// ─── Logger singleton ─────────────────────────────────────────────────────────

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB — rotate beyond this
const FLUSH_DELAY_MS = 1500;           // batch writes to avoid hammering disk

class Logger {
  private dir = "";
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  /** Call once after resolving appDataDir. */
  init(appDataDir: string) {
    this.dir = appDataDir;
  }

  error(msg: string, error?: unknown, ctx?: unknown) {
    const stack =
      error instanceof Error
        ? error.stack ?? error.message
        : error !== undefined
        ? String(error)
        : undefined;
    this._push("error", msg, stack, ctx);
    // Also mirror to devtools console
    console.error(`[ERROR] ${msg}`, error ?? "", ctx ?? "");
  }

  warn(msg: string, ctx?: unknown) {
    this._push("warn", msg, undefined, ctx);
    console.warn(`[WARN] ${msg}`, ctx ?? "");
  }

  info(msg: string, ctx?: unknown) {
    this._push("info", msg, undefined, ctx);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _push(level: Level, msg: string, stack?: string, ctx?: unknown) {
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
    if (stack) entry.stack = stack;
    if (ctx !== undefined) entry.ctx = ctx;
    this.buffer.push(entry);
    this._scheduleFlush();
  }

  private _scheduleFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this._flush(), FLUSH_DELAY_MS);
  }

  /** Flush buffer to disk. Safe to call multiple times concurrently. */
  async _flush() {
    if (this.flushing || !this.dir || !this.buffer.length) return;
    this.flushing = true;

    const entries = this.buffer.splice(0); // drain buffer atomically

    try {
      const logsDir = this.dir + "/logs";
      if (!(await exists(logsDir))) {
        await mkdir(logsDir, { recursive: true });
      }

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const logPath = logsDir + "/app-" + today + ".log";

      // Rotate if file exceeds MAX_LOG_BYTES
      if (await exists(logPath)) {
        const info = await stat(logPath);
        if (info.size >= MAX_LOG_BYTES) {
          await rename(logPath, logPath + ".bak");
        }
      }

      // Append new entries (one JSON object per line — easy to grep/parse)
      const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      let existing = "";
      if (await exists(logPath)) {
        existing = await readTextFile(logPath);
      }
      await writeTextFile(logPath, existing + lines);
    } catch (e) {
      // If we can't write the log, at least print to console and put entries back
      console.error("[Logger] flush failed:", e);
      this.buffer.unshift(...entries);
    } finally {
      this.flushing = false;
    }
  }
}

export const logger = new Logger();

// ─── Global unhandled error capture ──────────────────────────────────────────
// These run in main.tsx but are defined here so the logger is always the
// single source of truth.

export function installGlobalErrorHandlers() {
  window.addEventListener("error", (ev) => {
    logger.error("Uncaught JS error", ev.error ?? ev.message, {
      file: ev.filename,
      line: ev.lineno,
      col: ev.colno,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    logger.error("Unhandled promise rejection", ev.reason);
  });

  // Tauri's WebView surfaces some errors as console.error.
  // Patch it so they also go through the logger.
  const _origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    _origError(...args);
    // Avoid infinite loop from logger itself calling console.error
    if (typeof args[0] === "string" && args[0].startsWith("[Logger]")) return;
    if (typeof args[0] === "string" && args[0].startsWith("[ERROR]")) return;
    logger._push("error", args.map(String).join(" "));
  };
}
