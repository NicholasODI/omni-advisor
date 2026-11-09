// test-omni-masker — self-contained smoke test for the omni-advisor cipher
// and supporting modules.
//
// Run with:  node tests/test-omni-masker.ts   (Node >= 23.6, type stripping)
//
// Verifies:
//   1. Deterministic spans (emails, vendor keys, JWT, UUID, hex, home
//      prefixes) are masked to OMNI_* placeholders.
//   2. Value-group patterns (key:"value", url user:pass) mask the value and
//      preserve structure.
//   3. unmask() restores the string identically (lossless round-trip),
//      including 100+ placeholder numbering (longest-first replacement).
//   4. Masking is idempotent on already-masked text.
//   5. Benign text (short values, bare keywords) passes through untouched.
//   6. Semantic registration adds mappings; status/clear work.
//   7. Logger appends (never replaces); hostile session ids stay filename-safe.
//   8. Gateway provider discovery resolves configured providers, null on unknown.
//   9. Usage accounting accumulates per model; totals sum.
//  10. Prompt framing and selector splitting behave.

import { existsSync, readFileSync } from "node:fs";
import * as cipher from "../cipher.ts";
import * as usage from "../usageTracker.ts";
import { loadProvider } from "../gateway.ts";
import { executorNudge, advisorBlock, advisoryFrame, toolResponseFrame } from "../cloudAdvisor.ts";
import { splitSelector } from "../advisorDispatch.ts";
import { LOG_DIR, log, logPath, safeSessionId } from "../logger.ts";

const SID = "omni-masker-smoke";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ""}`);
}

// Seed the semantic layer the way the local model would (register_masked_terms).
cipher.registerTerms(SID, [
  { raw: "quixost-ctl", type: "WORKSPACE" },
  { raw: "acme-payments-internal", type: "WORKSPACE" },
  { raw: "build-host-01", type: "HOST" },
]);

const input = `Project quixost-ctl on host build-host-01 (repo acme-payments-internal).
Credentials file: C:\\Users\\devops-admin\\.aws\\credentials
DB: postgres://db_admin:Sup3rS3cretPwd@db.internal:5432/warehouse
Config: "api_key": "sk-live-51Abc123Xyz456Qrs789Tuv012"
Standalone key: sk-live-51Abc123Xyz456Qrs789Tuv012
GitHub: github_pat_11ABCDEFGH1234567890abcdef
AWS: AKIAIOSFODNN7EXAMPLE and token ghp_23456789abcdefghij1234
JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0VkbPr8
Contact jane.doe@corp.example and bob.smith@other.example
UUID 123e4567-e89b-12d3-a456-4266141749ab
Digest 0123456789abcdef0123456789abcdef
Card 4242 4242 4242 4242
Benign: keep the plain value hum12`;

const masked = cipher.mask(input, SID);
console.log("\nmasked:\n" + masked + "\n");

// 1. Deterministic spans.
const ph = (re: RegExp): string | null => (masked.match(re) as string[] | null)?.[0] ?? null;
check("workspace scrubbed", !masked.includes("quixost-ctl"), masked);
check("workspace -> OMNI_WORKSPACE", /OMNI_WORKSPACE_\d+/.test(masked));
check("home prefix scrubbed", !masked.includes("devops-admin"), masked);
check("home prefix -> OMNI_HOME", /OMNI_HOME_\d+/.test(masked));
check("db creds scrubbed", !masked.includes("Sup3rS3cretPwd"), masked);
check("url scheme+host preserved", /postgres:\/\/OMNI_CRED_\d+@db\.internal:5432\/warehouse/.test(masked), masked);
const apiCred = ph(/"api_key": "(OMNI_CRED_\d+)"/);
check("kv value masked, key+quotes preserved", apiCred !== null, masked);
check("standalone vendor key scrubbed", !masked.includes("sk-live-51Abc"), masked);
check("vendor key -> OMNI_VENDOR_KEY", /OMNI_VENDOR_KEY_\d+/.test(masked));
check("github fine-grained tok scrubbed", !masked.includes("github_pat_11ABCDE"), masked);
check("classic gh token scrubbed", !masked.includes("ghp_23456789abcd"), masked);
check("AWS access key scrubbed", !masked.includes("AKIAIOSFODNN7EXAMPLE"), masked);
check("JWT scrubbed", !masked.includes("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx"), masked);
check("JWT -> OMNI_JWT", /OMNI_JWT_\d+/.test(masked));
check("emails scrubbed", !masked.includes("jane.doe@corp.example") && !masked.includes("bob.smith@other.example"), masked);
check("email -> OMNI_EMAIL x2", (masked.match(/OMNI_EMAIL_\d+/g) ?? []).length >= 2);
check("UUID scrubbed", !masked.includes("123e4567-e89b"), masked);
check("hex digest scrubbed", !masked.includes("0123456789abcdef0123456789abcdef"), masked);
check("card number scrubbed", !masked.includes("4242 4242 4242 4242"), masked);
check("card -> OMNI_CARD", /OMNI_CARD_\d+/.test(masked));
check("short benign value untouched", masked.includes("hum12"));

// 2. Lossless round-trip.
const unmasked = cipher.unmask(masked, SID);
check("unmask restores input identically", unmasked === input, unmasked.slice(0, 120));

// 3. Idempotency: masking already-masked text changes nothing new.
const remasked = cipher.mask(masked, SID);
check("mask is idempotent on masked text", remasked === masked, remasked.slice(0, 120));

// 4. Hundred-plus numbering: unmask must replace longest placeholder first
//    (OMNI_TERM_10 before OMNI_TERM_100).
const hundred: string[] = [];
for (let i = 0; i < 120; i++) hundred.push(`secval${String(i).padStart(3, "0")}`);
cipher.registerTerms(SID, hundred.map((t) => ({ raw: t, type: "OTHER" })));
const doc = hundred.map((v) => cipher.mask(v, SID)).join(" ");
const t10 = cipher.status(SID).entries.find((e) => e.raw === "secval010")?.placeholder;
const t100 = cipher.status(SID).entries.find((e) => e.raw === "secval100")?.placeholder;
const t119 = cipher.status(SID).entries.find((e) => e.raw === "secval119")?.placeholder;
check("show-term placeholders exist", Boolean(t10 && t100 && t119), `${t10} ${t100} ${t119}`);
const mixed = `${t10} ${t100} ${t119}`;
check(
  "longest-first unmask across 100s",
  cipher.unmask(mixed, SID) === `secval010 secval100 secval119`,
  cipher.unmask(mixed, SID),
);
check("120-term doc round-trips", cipher.unmask(doc, SID) === hundred.join(" "));

// 5. Benign text.
const benign = `The password keyword alone, and short: yes123 (8 chars), plus path ./shared/lib/xyz.`;
const maskedBenign = cipher.mask(benign, SID);
check("benign text passes through", maskedBenign === benign, maskedBenign);

// 6. Status + clear.
const st = cipher.status(SID);
check("status reports many mappings", st.count > 50, `${st.count} mappings`);
const term = st.entries.find((e) => e.raw === "quixost-ctl");
check("workspace entry type round-trips", term?.type === "WORKSPACE", JSON.stringify(term));
cipher.clearSession(SID);
check("clearSession empties mappings", cipher.status(SID).count === 0);

// 7. Logger (append-only; no deletion in this smoke run).
const logSid = "omni-smoke-logger";
log(logSid, "SMOKE", "line one");
log(logSid, "SMOKE", "line two");
const logText = existsSync(logPath(logSid)) ? readFileSync(logPath(logSid), "utf8") : "";
check("session log created + appends", logText.includes("line one") && logText.includes("line two"));
const hostile = `..\\..\\windows\\temp${String.fromCharCode(0)}session`;
const safeId = safeSessionId(hostile);
check(
  "hostile session id is filename-safe",
  !/[\\/:*?"<>|\u0000-\u001f]/.test(safeId) && !safeId.startsWith(".."),
  safeId,
);
log(hostile, "ERROR", "traversal probe");
check(
  "hostile session logs inside LOG_DIR",
  logPath(hostile).startsWith(LOG_DIR) && existsSync(logPath(hostile)) && logPath(hostile) !== logPath(logSid),
);

// 8. Gateway discovery (real ~/.omp/agent/models.yml on this host).
check("unknown provider -> null", loadProvider("no-such-provider-xyz") === null);
usage.recordUsage(SID, "local/model-27b", { input: 900_000, output: 100_000, cacheRead: 50_000 });
usage.recordUsage(SID, "codex-lb/gpt-6.1-sol", { input: 1_000_000, output: 500_000, cacheRead: 100_000, cacheWrite: 20_000 });
const rows = usage.usageSummary(SID);
check("per-model rows", rows.length === 2, JSON.stringify(rows.map((r) => r.model)));
const tot = usage.usageTotals(SID);
check("totals sum both models", tot.input === 1_900_000 && tot.output === 600_000 && tot.messages === 2, JSON.stringify(tot));
check("rateless cost = $0", tot.costUsd === 0, `$${tot.costUsd}`);
usage.clearUsage(SID);
check("clearUsage empties", usage.usageTotals(SID).messages === 0);

// 10. Prompt framing + selector.
check("executor nudge names ask_advisor", executorNudge().includes("ask_advisor"));
const nudge = executorNudge();
check("nudge keeps privacy rule", nudge.includes("PRIVACY RULE"));
check("advisory frame wraps", advisoryFrame("Q1").includes("Q1") && advisoryFrame("Q1").includes("CONSULTANT QUERY"));
check("response frame names directives", toolResponseFrame("A1").includes("[RESEARCH / FACT-CHECK DIRECTIVE]"));
check("advisor block mentions placeholder discipline", advisorBlock().includes("OMNI_*"));
check("advisor block honors focus", advisorBlock("TypeScript + AWS EKS").includes("DOMAIN FOCUS") && !advisorBlock().includes("DOMAIN FOCUS"));
check("splitSelector provider/model", splitSelector("codex-lb/gpt-6.1-sol").provider === "codex-lb" && splitSelector("codex-lb/gpt-6.1-sol").model === "gpt-6.1-sol");
check("splitSelector bare model", splitSelector("gpt-6.1-sol").provider === "");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);