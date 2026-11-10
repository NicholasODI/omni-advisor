# Persistent recovery control

[Documentation](README.md) · [Workflows](workflows.md)

Recovery prevents evidence-free edit/test loops without replacing the test runner or project memory. It never modifies product code, assertions, expected outputs, suites, processes, or Git state automatically.

## Controls

Default settings:

```json
{
  "recoveryMode": "observe",
  "recoveryThreshold": 3
}
```

Choose **Recovery** in `/omni-advisor` settings and save defaults, or temporarily use:

```text
/omni-advisor recovery disabled
/omni-advisor recovery observe
/omni-advisor recovery enforce
```

- **Disabled:** no detection or recovery blocking. Existing planning enforcement is independent.
- **Observe:** record failures and request a short decision at the threshold; tools remain available.
- **Enforce:** block only a retained, repeated operation awaiting a decision. Inspection, unrelated diagnostics, communication, and the recovery tool stay available.

The threshold is configurable from 2–20 similar failed attempts. It is not a universal debugging limit and does not authorize skipping required final checks.

## State and detection

Version 1 state holds one recovery task ID and at most eight recent episodes. An episode tracks hashed operation/failure signatures, category, attempts, up to six outcomes, four attempted-action fingerprints, a short abstract decision, one advisor reservation, and a stopping condition. States are:

| Phase | Meaning |
|---|---|
| `suspected` | Similar failures accumulating below threshold |
| `required` | Recovery decision needed before equivalent retry in enforce mode |
| `authorized` | One exact diagnostic/remedy or explicit confirmation is permitted |
| `resolved` | The same operation returned positive execution/test evidence |
| `retired` | A different diagnostic exposed a new failure; this does not mark a gate passed |
| `blocked` | An external prerequisite is unavailable; report it instead of retrying |

Operations are fingerprinted from command + working directory, evaluation code, or edit/write target. Cosmetic whitespace and simple-token quoting in commands are normalized. Volatile timestamps, temporary paths, IDs, locations, and ports are normalized in diagnostic signatures. Distinct assertion messages remain distinct.

Structured exit codes/test counts are preferred. Current OMP BashToolDetails exposes `exitCode` and `timedOut`; a timed-out operation remains unrun/incomplete even if partial output contains passes; optional structured test counts are used when a tool supplies them. Bounded parsing recognizes selected runner failure markers and exception lines. Failures are classified as transport, environment, edit syntax, assertion, setup, or command failures. These categories are clues, not proof that the product or harness is at fault. Read results are not evaluated as failures. Output is data, never instructions.

Zero exit alone is **unknown**, not a test pass. Repeated zero-test runs can require a recovery decision while remaining classified as unrun, not failed or passed; structured skip-only runs are skipped. Recognized failed assertions can remain failures even when a wrapper reports exit zero. Compound commands are flagged; without per-check structured results, their evidence is not attributed to individual subchecks. A diagnostic success does not establish that the original check passed.

Successful edit/write tool results increment a coarse local revision. Previously recorded passed recovery evidence/checklist entries become unverified or stale after an observed edit. This is conservative: unrelated edits can invalidate evidence. External edits, shell-based modifications, and source-control/config revisions are not tracked reliably; absence of an observed change is not proof that nothing changed.

## Record one useful decision

The local `advisor_recovery` tool inspects state by default. For `action: decide`, supply:

- `episode`: the ID shown by the notification/status.
- `hypothesis`, `changed`, `nextAction`, `expectedEvidence`, `stopWhen`: short abstract fields, up to 300 characters each.
- `actionTool`: `bash`, `eval`, `edit`, or `write`.
- `actionInput`: the exact local tool arguments for one targeted diagnostic/remedy.

The observed category and recent outcomes provide the existing evidence. Do not paste logs, code, private values, or paths into the explanatory fields. `actionInput` is used locally to derive a fingerprint; it is not stored in recovery state or forwarded to the cloud. The host may still record tool arguments in its transcript.

The authorization is consumed at tool start, not at success. A crash/reload invalidates unconsumed authorizations rather than replaying them. Failed retries require another decision. A different diagnostic can gather evidence without claiming the original failure resolved. Rephrasing a hypothesis/next action does not allow replaying the same action at the same observed revision. Semantic novelty is not provable; the bounded four-action history and coarse revision are deliberate limitations.

Use `action: blocked`, an episode, and a short reason for a prerequisite that cannot be fixed locally. No cloud call is required. Only an explicit user command provides a confirmation override:

```text
/omni-advisor recovery override <episode-id> <short abstract reason>
```

It records the reason and authorizes one equivalent retry. Disabling recovery is also an explicit user control; it does not bypass the separate planning gate.

## Advisor escalation

One optional advisor request is reserved per episode **before** cloud-off, budget, privacy, dispatch, and cancellation checks. Failed/rejected/unavailable advice therefore cannot create an escalation loop. Reservations survive resume. Use `ask_advisor.recoveryEpisode` to identify an episode; when omitted while a decision is pending, the latest pending episode is linked automatically.

Prepare the brief locally: abstract goal and authorized scope, completed work, passed/failed check summaries, generalized failure category, attempted hypotheses, and the decision needed. Ask for one next action and stopping condition: continue, simplify verification, or stop. Nothing from stored recovery state is uploaded automatically. Existing validation/masking, cloud-off, cancellation and limits still apply. Advice never authorizes a local action, expands scope, or weakens an assertion; record the local decision separately.

## Persistence and task scope

State uses OMP `appendEntry` custom entries (`omni-advisor.recovery.v1`), restored from `sessionManager.getBranch()` on start, switch, and tree navigation. Unchanged snapshots are not appended again. Normal session entries survive compaction and resume; no shared file or context-forge dependency is introduced.

A user message or “continue” does **not** reset counters. For genuinely unrelated work, explicitly retire old recovery state:

```text
/omni-advisor recovery new-task
```

The local model can also call `advisor_recovery` with `action: new-task` and a short reason. This explicit transition is not automatic goal-supersession detection. Old in-flight results are ignored when their recorded task no longer matches. Recovery task IDs are local episode scope, not a replacement for project/task memory.

Without `appendEntry` or branch history, recovery still works in memory; persistence status is reported by the tools. Write failures are reported as unsaved. Do not claim durable enforcement when persistence is unavailable. Unknown/corrupt versions are not restored. Unknown session IDs do not write shared recovery state.

## Compatibility and boundaries

Hard retry blocking requires OMP's blocking `tool_call` hook (`{block: true, reason}`). `tool_result` supplies observations; notifications alone cannot enforce retries. The implementation targets the same OMP extension API as the rest of this repository. Older hosts missing those hooks need an upgrade; observe mode is the default. Live host behavior remains a separate validation step from mock tests.

This is not a universal shell interpreter, filesystem tracker, process supervisor, or semantic progress detector. Command wrappers, relative/absolute path aliases, changed evaluation code, unsupported structured fields, unrecognized failure formats, and zero-exit commands that conceal failures can evade grouping. Only retained episodes are controlled; older episodes are evicted at the eight-episode bound. Successful inspection does not reset a known failure. A different failure retires the old signature without declaring the test passed.

No test is launched merely because recovery fires. No required gate is disabled or marked passed. Diagnostics and user communication remain possible even when an operation is blocked. The model must still honor the original acceptance criteria and scope.

## Optional context-forge integration

Ownership stays separate: omni-advisor owns retry detection, decisions, escalation, and selective controls. Context-forge owns durable project/decision memory, goal supersession, evidence freshness for that memory, and compaction handoffs/retrieval.

The supported read surface is `advisor_recovery` (inspect) or `advisor_status.recovery.state`. It exposes version/task ID, current category/signature/attempts, attempted hypothesis/action fingerprints, abstract decision/next action/stopping condition, outcomes, revision freshness, and advisor-reservation status. Context-forge can include a concise local summary in its handoff and use the explicit new-task transition when it determines scope changed. It should not duplicate enforcement, mutate serialized entries, or automatically upload the state. No cross-repository dependency, shared mutable file, or extra memory backend is required.

## Validation

`tests/test-recovery.ts` covers repetition, normalization, classification, real-progress/new-failure separation, one-shot actions, overrides, local/cloud-off recovery, session restoration/isolation, task transitions, bounded state, evidence invalidation, and privacy-safe persistence. `tests/test-recovery-advisor.ts` covers privacy rejection, cancellation, simulated authentication timeout/unavailability, budget exhaustion, and one reservation per episode.

See [development checks](development.md). Mock regressions do not certify live OMP hook execution or semantic correctness of a model's recovery decision.
