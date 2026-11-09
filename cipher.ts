// cipher — stateful bidirectional cipher for session-specific sensitive data.
//
// Per-session mapping (placeholder -> raw value) that scrubs sensitive values
// out of outbound cloud-advisor payloads and restores them on the way back.
// Standalone module (node: only) so the smoke test can import it without the
// omp runtime.
//
// This is the DOMAIN-GENERAL sibling of ns-advisor's netsuiteCipher: no
// NetSuite patterns. Detection layers:
//   A. Deterministic spans (whole match = sensitive value): emails, vendor API
//      keys, JWTs, private/SSH key blocks, high-entropy hex/base64, UUIDs,
//      card numbers, home-directory prefixes.
//   B. Value-group patterns (mask the value, preserve structure): key=id/
//      token: "secret" pairs, user:pass in URL authority, home paths.
//   C. Semantic terms registered out-of-band (config file, or the
//      register_masked_terms tool called by the local model — the local LLM
//      is the semantic filter: it registers the workspace/host/person/secret
//      terms it observes so later cloud calls stay masked).
//
// Replacement semantics:
//   - Longest matches first; overlapping spans resolve to the longest match
//   - Value-group patterns mask only the value, preserving surrounding
//     structure (quotes, colons, @, path tails)
//   - Idempotent: values already mapped in the session pass through to the
//     same placeholder and are never double-registered
//   - unmask() restores every placeholder back to its original value
//     (lossless round-trip)

import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log, LOG_DIR, safeSessionId } from "./logger.ts";

/** Request protection uses in-memory mappings only. Legacy sidecars are never hydrated. */
function sidecarPath(key: string): string {
  return join(LOG_DIR, safeSessionId(key) + ".cipher.json");
}
interface SessionCipher {
  key: string;
  mapping: Map<string, string>;
  reverse: Map<string, string>;
  counters: Map<string, number>;
}

export type TermType =
  | "EMAIL"
  | "JWT"
  | "VENDOR_KEY"
  | "PRIVATE_KEY"
  | "SSH_KEY"
  | "HEX"
  | "B64"
  | "UUID"
  | "CARD"
  | "HOME"
  | "CRED"
  | "WORKSPACE"
  | "HOST"
  | "PERSON"
  | "SECRET"
  | "TERM";

const PREFIX_BY_TYPE: Record<TermType, string> = {
  EMAIL: "OMNI_EMAIL",
  JWT: "OMNI_JWT",
  VENDOR_KEY: "OMNI_VENDOR_KEY",
  PRIVATE_KEY: "OMNI_PRIVATE_KEY",
  SSH_KEY: "OMNI_SSH_KEY",
  HEX: "OMNI_HEX",
  B64: "OMNI_B64",
  UUID: "OMNI_UUID",
  CARD: "OMNI_CARD",
  HOME: "OMNI_HOME",
  CRED: "OMNI_CRED",
  WORKSPACE: "OMNI_WORKSPACE",
  HOST: "OMNI_HOST",
  PERSON: "OMNI_PERSON",
  SECRET: "OMNI_SECRET",
  TERM: "OMNI_TERM",
};

const TYPE_BY_PREFIX: Record<string, TermType> = {
  OMNI_EMAIL: "EMAIL",
  OMNI_JWT: "JWT",
  OMNI_VENDOR_KEY: "VENDOR_KEY",
  OMNI_PRIVATE_KEY: "PRIVATE_KEY",
  OMNI_SSH_KEY: "SSH_KEY",
  OMNI_HEX: "HEX",
  OMNI_B64: "B64",
  OMNI_UUID: "UUID",
  OMNI_CARD: "CARD",
  OMNI_HOME: "HOME",
  OMNI_CRED: "CRED",
  OMNI_WORKSPACE: "WORKSPACE",
  OMNI_HOST: "HOST",
  OMNI_PERSON: "PERSON",
  OMNI_SECRET: "SECRET",
  OMNI_TERM: "TERM",
};

/** Whole-match patterns: the full match is the sensitive value.
 *  Deliberately conservative (long, unambiguous shapes) — the semantic
 *  layer (registered terms) covers everything shorter/softer.
 */
const SPAN_PATTERNS: Array<{ type: TermType; re: RegExp }> = [
  // Emails
  { type: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g },
  // PEM private key blocks (open, EC, DSA, PKCS8)
  { type: "PRIVATE_KEY", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  // SSH public keys (type + b64 blob + optional comment, to end of line)
  { type: "SSH_KEY", re: /\bssh-(?:rsa|ed25519|dss) [A-Za-z0-9+/=]{16,}[^\r\n]*/g },
  // JWTs (three base64url segments)
  { type: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  // Vendor keys: sk-/pk-/rk-/dk- (OpenAI, Stripe, Anthropic, ...), GitHub
  // tokens (classic + fine-grained), Google API keys, AWS access key ids,
  // Slack tokens, HuggingFace tokens.
  { type: "VENDOR_KEY", re: /\b(?:sk|pk|rk|dk)[-_][A-Za-z0-9_-]{16,}\b/g },
  { type: "VENDOR_KEY", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { type: "VENDOR_KEY", re: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g },
  { type: "VENDOR_KEY", re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: "VENDOR_KEY", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "VENDOR_KEY", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "VENDOR_KEY", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  // UUIDs / GUIDs
  { type: "UUID", re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  // Card numbers (with or without separators)
  { type: "CARD", re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}\b/g },
  // High-entropy hex (MD5/SHA digests, connection passwords, hex secrets)
  { type: "HEX", re: /\b[0-9a-fA-F]{32,64}\b/g },
  // Long base64 (secrets, AWS secret access keys at 40+ chars, compressed blobs)
  { type: "B64", re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
];

/** Key=value / key:"value" secret pairs: mask the value, keep the key and
 *  quotes. Value must be one unbroken 12–128 char token of the secret
 *  alphabet; pure numbers and already-masked placeholders are skipped. */
const KV_RE =
  /\b(api[_-]?key|apisecret|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret[_-]?key|signing[_-]?secret|client[_-]?secret|passphrase|passw(?:or)?d|private[_-]?key|credential|token|secret)\b(["']?)(\s*[:=]\s*)(["']?)([A-Za-z0-9._\-/+]*)\4/gi;

function kvValueOk(val: string): boolean {
  return val.length >= 12 && val.length <= 128 && !/^OMNI_/.test(val) && !/^\d+$/.test(val);
}

const sessions = new Map<string, SessionCipher>();

function session(key: string): SessionCipher {
  let s = sessions.get(key);
  if (!s) {
    s = { key, mapping: new Map(), reverse: new Map(), counters: new Map() };
    sessions.set(key, s);
  }
  return s;
}

function register(s: SessionCipher, type: TermType, raw: string): string {
  if (!raw) return "";
  const existing = s.reverse.get(raw);
  if (existing) return existing; // idempotent: same value -> same placeholder
  const prefix = PREFIX_BY_TYPE[type];
  const n = (s.counters.get(prefix) ?? 0) + 1;
  s.counters.set(prefix, n);
  const placeholder = `${prefix}_${String(n).padStart(2, "0")}`;
  s.mapping.set(placeholder, raw);
  s.reverse.set(raw, placeholder);
  log(s.key, "SANITIZE", `Registered ${placeholder} (${type})`);
  return placeholder;
}

interface Span {
  start: number;
  end: number;
  raw: string;
  type: TermType;
}

function termTypeOf(placeholder: string): TermType {
  const head = placeholder.replace(/_\d+$/, "");
  return TYPE_BY_PREFIX[head] ?? "TERM";
}

/** Collect spans (semantic terms + deterministic patterns), longest match
 *  first, overlapping spans dropped in favor of the longest. */
function collectSpans(text: string, s: SessionCipher): Span[] {
  const candidates: Span[] = [];

  // Semantic layer: every raw value known to this session (terms registered
  // by the local model / config, plus values scrubbed earlier this session).
  for (const [raw, placeholder] of s.reverse) {
    if (!raw) continue;
    const type = termTypeOf(placeholder);
    let idx = text.indexOf(raw);
    while (idx !== -1) {
      candidates.push({ start: idx, end: idx + raw.length, raw, type });
      idx = text.indexOf(raw, idx + raw.length);
    }
  }

  // Deterministic layer. A span that overlaps an already-emitted placeholder
  // (e.g. an email regex matching over "OMNI_CRED_01@host") is rejected so
  // we never re-encrypt a placeholder we own.
  const placeholders: Array<{ start: number; end: number }> = [...s.mapping.keys()].flatMap((ph) => {
    const out: Array<{ start: number; end: number }> = [];
    let idx = text.indexOf(ph);
    while (idx !== -1) {
      out.push({ start: idx, end: idx + ph.length });
      idx = text.indexOf(ph, idx + ph.length);
    }
    return out;
  });
  for (const p of SPAN_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const match = m;
      if (match[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      // Mixed-case/digit evidence avoids treating slash-separated state names as secrets.
      // Explicit credential assignments and registered terms remain separate safeguards.
      if (p.type === "B64" && !(/[A-Z]/.test(match[0]) && /[a-z]/.test(match[0]) && /[0-9]/.test(match[0]))) continue;
      if (placeholders.some((pp) => match.index < pp.end && match.index + match[0].length > pp.start)) continue;
      candidates.push({ start: match.index, end: match.index + match[0].length, raw: match[0], type: p.type });
    }
  }

  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: Span[] = [];
  for (const c of candidates) {
    if (!accepted.some((a) => c.start < a.end && c.end > a.start)) accepted.push(c);
  }
  accepted.sort((a, b) => b.start - a.start); // replace from the end
  return accepted;
}

/** Mask every sensitive value in `text` for session `key`. */
export function mask(text: string, key: string): string {
  const s = session(key);
  let out = text;

  // Pass 1: value-group patterns — mask the value, preserve structure.
  out = out.replace(KV_RE, (_m: string, k: string, kq: string, eq: string, q: string, val: string) => {
    if (!kvValueOk(val)) return _m;
    return k + kq + eq + q + register(s, "CRED", val) + q;
  });
  out = out.replace(/([a-z][a-z0-9+.\-]*:\/\/)([^:@/\s]+:[^:@/\s]+)@/gi, (_m, proto: string, creds: string) => {
    if (!creds || /^OMNI_/.test(creds)) return _m;
    return proto + register(s, "CRED", creds) + "@";
  });
  out = out.replace(/(^|[\s'"=:(;])([A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/g, (m: string, pre: string, p: string) => {
    if (/^OMNI_/.test(p)) return m;
    return pre + register(s, "HOME", p);
  });
  out = out.replace(/(^|[\s'"=:(;])(\/(?:home|Users|root)\/[A-Za-z0-9._-]+)/g, (m: string, pre: string, p: string) => {
    if (/^OMNI_/.test(p)) return m;
    return pre + register(s, "HOME", p);
  });

  // Pass 2: semantic terms + deterministic whole-match spans, longest first.
  let cursor = out;
  for (const span of collectSpans(out, s)) {
    cursor = cursor.slice(0, span.start) + register(s, span.type, span.raw) + cursor.slice(span.end);
  }
  return cursor;
}

/** Restore every placeholder in `text` to its original value for session `key`. */
export function unmask(text: string, key: string): string {
  const s = session(key);
  if (s.mapping.size === 0) return text;
  // Longest placeholder first so OMNI_VENDOR_KEY_01 is not shadowed by a
  // shorter prefix token (and OMNI_TERM_100 is replaced before OMNI_TERM_10).
  let out = text;
  for (const ph of [...s.mapping.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(ph).join(s.mapping.get(ph)!);
  }
  return out;
}

export type SemanticTermType = "WORKSPACE" | "HOST" | "PERSON_OR_ORG" | "SECRET" | "OTHER";

/** Register semantic terms (local-LLM / config layer) for session `key`.
 *  Returns the placeholders assigned to each new term. */
export function registerTerms(
  key: string,
  terms: Array<{ raw: string; type?: SemanticTermType }>,
): string[] {
  const s = session(key);
  const added: string[] = [];
  for (const t of terms) {
    if (!t.raw || !t.raw.trim()) continue;
    const type: TermType =
      t.type === "WORKSPACE"
        ? "WORKSPACE"
        : t.type === "HOST"
          ? "HOST"
          : t.type === "PERSON_OR_ORG"
            ? "PERSON"
            : t.type === "SECRET"
              ? "SECRET"
              : "TERM";
    const ph = register(s, type, t.raw);
    if (!added.includes(ph)) added.push(ph);
  }
  return added;
}

export interface CipherStatus {
  count: number;
  entries: Array<{ placeholder: string; raw: string; type: TermType }>;
}

export function status(key: string): CipherStatus {
  const s = session(key);
  return {
    count: s.mapping.size,
    entries: [...s.mapping.entries()].map(([placeholder, raw]) => ({ placeholder, raw, type: termTypeOf(placeholder) })),
  };
}

/** Forget local values at session end without touching legacy files. */
export function forgetSession(key: string): void { sessions.delete(key); }

/** Drop one session's mapping (or all when key is omitted); removes a legacy sidecar too. */
export function clearSession(key?: string): void {
  if (key === undefined) {
    sessions.clear();
    try {
      for (const f of readdirSync(LOG_DIR)) {
        if (f.endsWith(".cipher.json")) unlinkSync(join(LOG_DIR, f));
      }
    } catch {
      /* no logs dir — nothing to remove */
    }
  } else {
    sessions.delete(key);
    try {
      unlinkSync(sidecarPath(key));
    } catch {
      /* no sidecar — nothing to remove */
    }
  }
}