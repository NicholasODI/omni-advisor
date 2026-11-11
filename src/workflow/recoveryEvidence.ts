/** Bounded interpretation of tool evidence; no session writes or retry authorization. */
import { createHash } from "node:crypto";
import { logicalChecks } from "./logicalChecks.ts";
export type FailureCategory =
  | "transport"
  | "environment"
  | "edit-syntax"
  | "assertion"
  | "setup"
  | "command";
export type Outcome = "passed" | "failed" | "skipped" | "unrun" | "unknown";
const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);
export function normalizeDiagnostic(text: string): string {
  return text
    .slice(0, 12000)
    .toLowerCase()
    .replace(/\d{4}-\d\d-\d\d[t ][\d:.+z-]+/g, "<time>")
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, "<id>")
    .replace(/(?:[a-z]:[\\/]|\/(?:tmp|var|home|users)\/)[^\s:)]+/g, "<path>")
    .replace(/\b(?:localhost|127\.0\.0\.1):\d+/g, "<service>")
    .replace(/\b(?:lines?|port|pid)\s*[:=]?\s*\d+/g, "<number>")
    .replace(/:\d+(?::\d+)?/g, ":<location>")
    .replace(/#[a-f0-9]{4,}/g, "#<tag>")
    .replace(/\s+/g, " ")
    .trim();
}
export function operationKey(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  if (tool === "edit" || tool === "write") {
    const anchor =
      typeof input.input === "string"
        ? input.input.match(/^\[([^\n#]+)(?:#[^\n]*)?\]/)?.[1]
        : undefined;
    const path = input.path ?? anchor;
    return typeof path === "string"
      ? hash(`file:${path.replace(/\\/g, "/").replace(/^\.\//, "")}`)
      : undefined;
  }
  if (tool === "bash") {
    if (typeof input.command !== "string") return undefined;
    const checks = logicalChecks(input.command, input.cwd);
    if (checks.length === 1) return checks[0].key;
    // Ignore cosmetic quoting of simple tokens; do not parse shell control flow.
    const command = input.command
      .replace(/['"]([\w./\\:-]+)['"]/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return hash(`bash:${String(input.cwd ?? "")}:${command}`);
  }
  return tool === "eval" && typeof input.code === "string"
    ? hash(`eval:${input.code.replace(/\s+/g, " ").trim()}`)
    : undefined;
}
export function legacyShellKey(
  input: Record<string, unknown>,
): string | undefined {
  return typeof input.command === "string"
    ? hash(
        `bash:${String(input.cwd ?? "")}:${input.command
          .replace(/['"]([\w./\\:-]+)['"]/g, "$1")
          .replace(/\s+/g, " ")
          .trim()}`,
      )
    : undefined;
}
export interface Observation {
  operation: string;
  signature: string;
  category: FailureCategory;
  outcome: Outcome;
  compound: boolean;
}
export function classify(
  tool: string,
  input: Record<string, unknown>,
  result: { isError?: boolean; content?: any[]; details?: any },
): Observation | undefined {
  const operation = operationKey(tool, input);
  if (!operation) return undefined;
  const text = (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .slice(0, 12000);
  const d = result.details ?? {};
  const exit = Number.isInteger(d.exitCode)
    ? d.exitCode
    : Number.isInteger(d.exit_code)
      ? d.exit_code
      : undefined;
  const tests = d.tests;
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  const failedCount = tests && count(tests.failed) && tests.failed > 0;
  const failedLine = text
    .split("\n")
    .find((line) =>
      /^\s*(?:FAIL(?:ED)?\b|[✖×]\s)|^\s*(?:E\s+)?(?:AssertionError|SyntaxError|TypeError|ReferenceError|ECONNREFUSED|ENOENT|command not found|No module named|cannot find module)\b|^\s*(?:=+\s*)?\d+ failed\b|^\s*(?:ℹ\s*)?fail(?:ed)?\s*[:= ]\s*[1-9]\d*|^RESULT pass=\d+ fail=[1-9]\d*|^\s*(?:Error:|> Build error occurred|Export encountered an error|[^\n]*: Permission denied\s*$)|^\s*[^\n]+\.tsx?\(\d+,\d+\): error TS\d+|^\s*(?:EXIT|BUILD[-_]EXIT|GATE_EXIT|PYTEST_EXIT)=([1-9]\d*)/i.test(
        line,
      ),
    );
  const failed =
    !!result.isError ||
    (exit !== undefined && exit !== 0) ||
    failedCount ||
    !!failedLine;
  const timedOut = d.timedOut === true;
  let outcome: Outcome = timedOut ? "unrun" : failed ? "failed" : "unknown";
  // A zero exit without runner evidence is not proof that intended tests executed.
  if (
    !failed &&
    !timedOut &&
    tests &&
    count(tests.passed) &&
    count(tests.failed)
  )
    outcome =
      tests.passed > 0 ? "passed" : tests.skipped > 0 ? "skipped" : "unrun";
  else if (!failed && !timedOut && /\b0 (?:tests?|passed)\b/.test(text))
    outcome = "unrun";
  else if (
    !failed &&
    !timedOut &&
    /\b[1-9]\d* passed\b|^\s*(?:ℹ\s*)?pass [1-9]\d*\s*$/m.test(text)
  )
    outcome = "passed";
  else if (!failed && !timedOut && (tool === "edit" || tool === "write"))
    outcome = "passed";
  let category: FailureCategory = outcome === "unrun" ? "setup" : "command";
  const diagnostic = timedOut
    ? "execution deadline expired before completion"
    : (failedLine ??
      (typeof d.error?.code === "string"
        ? d.error.code
        : failed
          ? (text.split("\n").find((l) => l.trim()) ?? "tool failure")
          : outcome));
  if (/Permission denied|EPERM|EACCES/i.test(diagnostic))
    category = "environment";
  else if (d.transportError === true) category = "transport";
  else if (timedOut) category = "environment";
  else if ((tool === "edit" || tool === "write") && failed)
    category = "edit-syntax";
  else if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENOENT|not found|not recognized as|No module named|cannot find module|unavailable/i.test(
      diagnostic,
    )
  )
    category = "environment";
  else if (
    /SyntaxError|TypeError|ReferenceError|fixture|setup|collection|collecting/i.test(
      diagnostic,
    )
  )
    category = "setup";
  else if (failedCount || /assert|\bFAIL/i.test(diagnostic))
    category = "assertion";
  const checks = tool === "bash" ? logicalChecks(input.command, input.cwd) : [];
  if (checks.length > 1 && outcome === "passed") outcome = "unknown";
  const buildFailure =
    checks.length === 1 && checks[0].kind === "build" && failed;
  const canonical =
    buildFailure &&
    /useContext|global-error|static (?:generation|pages)/i.test(text)
      ? "build static-generation failure"
      : category === "edit-syntax" &&
          /column cap|no retained read/i.test(diagnostic)
        ? "edit display cap requires fresh read"
        : category === "edit-syntax" &&
            /stale.*(?:tag|anchor)|(?:tag|anchor).*mismatch/i.test(diagnostic)
          ? "edit stale anchor"
          : normalizeDiagnostic(diagnostic);
  return {
    operation,
    signature: hash(`${category}:${canonical}`),
    category,
    outcome,
    compound: tool === "bash" && /&&|\|\||[;\n]/.test(String(input.command)),
  };
}
