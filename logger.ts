// logger — per-session, append-only debug logs for the omni-advisor extension.
//
// Standalone module (node: only) so it can be imported from the smoke test
// without the omp runtime. One file per OMP session:
//   ~/.omp/agent/extensions/omni-advisor/logs/<safe-session-id>.debug.log
//
// Files are APPEND-ONLY: existing content is never truncated, rotated, or
// replaced — not on startup, not on /omni-mask-clear, not on error recovery.
//
// Tags:
//   [SANITIZE]     values scrubbed by the cipher (masked raw -> placeholder)
//   [CIPHER]       semantic-term registration activity
//   [CIPHER_INIT]  config semanticTerms seeded for a session
//   [CLOUD_OUT]    masked payloads sent to the cloud advisor
//   [CLOUD_IN]     raw cloud advisor responses (still masked)
//   [UNMASK]       unmasking operations before responses reach the local model
//   [MODEL_USAGE]  per-message token usage + cost per model
//   [CLOUD_QUOTA]  advisor gateway token-limit data (best-effort)
//   [ADVISOR_MODEL] runtime advisor model override changes
//   [SESSION_END]  final summary appended on session_shutdown
//   [ERROR]        failures with stack traces

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_DIR = join(homedir(), ".omp", "agent", "extensions", "omni-advisor", "logs");

export type LogTag =
  | "SANITIZE"
  | "CIPHER"
  | "CIPHER_INIT"
  | "CLOUD_OUT"
  | "CLOUD_IN"
  | "UNMASK"
  | "MODEL_USAGE"
  | "CLOUD_QUOTA"
  | "ADVISOR_MODEL"
  | "SESSION_END"
  | "ERROR"
  | (string & {});

/**
 * Derive a stable, filename-safe session id. Path separators, drive prefixes,
 * and control characters are stripped (no path traversal is possible); a
 * SHA-256 digest of the raw id keeps the name stable and collision-free even
 * when two visible prefixes end up identical after sanitizing.
 */
export function safeSessionId(sessionId: string): string {
  const visible = sessionId
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return visible ? `${visible}-${digest}` : digest;
}

/** Path of the append-only log file for one OMP session. */
export function logPath(sessionId: string): string {
  return join(LOG_DIR, `${safeSessionId(sessionId)}.debug.log`);
}

/** Append one tagged, timestamped line to the session's log. Never throws. */
export function log(sessionId: string, tag: LogTag, message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] [${tag}] session=${safeSessionId(sessionId)} ${message.replace(/\r?\n/g, " | ")}\n`;
    appendFileSync(logPath(sessionId), line, "utf8");
  } catch {
    // Logging must never break the pipeline.
  }
}

/** Mask email addresses before anything reaches a log (PII guard). */
export function maskEmails(text: string): string {
  return text.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "EMAIL(masked)");
}