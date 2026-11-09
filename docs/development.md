# Development and testing

[Documentation](README.md) · [Repository overview](../README.md)

## Local checks

Node 24 is recommended; the standalone TypeScript tests require Node >=23.6 with native type stripping. There are no declared package dependencies, lockfile, or build/typecheck scripts. Native execution does not type-check the code.

Run each command from the repository root:

```sh
node test-omni-masker.ts
node test-planning.ts
node test-planning-gate.ts
node test-omp-advisor.ts
node test-improvements.ts
node test-advisor-progress.ts
node test-advisor-stream.ts
node test-recovery.ts
node test-settings.ts
node test-privacy-policy.ts
```

| Suite | Focus |
|---|---|
| `test-omni-masker.ts` | Masking round trips, registration, logging, accounting, prompt basics |
| `test-planning.ts` | Provider payloads, privacy boundary, HTTPS, usage, cancellation, cloud-off |
| `test-planning-gate.ts` | Discovery/execution gating, stale results, task lifecycle, explicit opt-out |
| `test-omp-advisor.ts` | Registry/auth reuse and isolated completion context |
| `test-improvements.ts` | Technical-context preservation, diagnostics, metrics, checklist/compaction |
| `test-advisor-progress.ts` | Heartbeats, terminal cleanup, cancellation, optional UI, theme colors |
| `test-advisor-stream.ts` | SSE framing, phases, reasoning exclusion, usage, incomplete/truncated streams |
| `test-recovery.ts` | Mixed-runner failures, same-file grouping, one hint per task, compaction |
| `test-settings.ts` | Menu navigation, cancellation, provider validation, persistence, workflow prompts |
| `test-privacy-policy.ts` | Structural context, sensitive input rejection before dispatch, memory-only mappings |

Tests may write logs under the normal `~/.omp/agent/extensions/omni-advisor/logs` directory. A workspace-only sandbox may require approved access to that user directory. Do not change application behavior to make a sandbox permission failure pass.

## What tests establish

Provider tests use local mocks/intercepted network calls. They do not establish live provider authentication, live OMP UI rendering, provider retention policy, or comprehensive confidentiality. Privacy tests cover selected known cases, not every way information can be encoded in prose.

For a live check, load this checkout's `index.ts` in OMP, select a configured advisor, test cloud-off first, then enable access and submit a synthetic abstract task. Confirm progress, the returned plan, and local execution behavior. Test enforcement/compaction only if that workflow matters. Avoid real sensitive records in test prompts.

Use bounded verification. A failed homemade browser harness is not automatically evidence of a product defect. If a user will check the UI manually, report visual limitations rather than expanding a replacement browser framework.
