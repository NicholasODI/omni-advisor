# Workflows and planning enforcement

[Documentation](README.md) · [Repository overview](../README.md)

## Choose a workflow

All modes keep file access, tools, implementation, and tests local. Changing a mode does not turn cloud access on.

| Mode | Cloud involvement |
|---|---|
| **Balanced** — default | Initial plan, consequential unsettled decisions, one final abstract review |
| **Local-led** | Initial plan, then focused escalation when needed |
| **Cloud-led** | Selects the next meaningful execution batch from abstract feedback |

Choose a workflow in `/omni-advisor`, or use:

```text
/omni-advisor mode balanced
/omni-advisor mode local-led
/omni-advisor mode cloud-led
```

### Balanced

For nontrivial tasks, the local model gathers facts before requesting a plan. It asks again for consequential choices that the plan did not settle, or when verified facts invalidate assumptions. Before completion, it requests one final review of summarized acceptance evidence and residual risks.

Trivial tasks stay local. There is no required mid-task call if the original plan already settles the decision. Final-review gaps are addressed locally; another review needs materially new architectural evidence. Routine syntax, commands, debugging, and tests do not require cloud supervision.

### Local-led

The local model executes the initial plan and consults again for a material discrepancy, consequential uncertainty, or a stalled approach. This is the lighter option when the local executor handles independent work well.

### Cloud-led

The advisor returns one bounded work batch with an outcome, constraints/invariants, suggested implementation steps, acceptance checks, and return conditions. Steps are provisional; acceptance criteria remain binding.

The local model adapts minor file/helper/API differences itself. It returns abstract outcomes after the batch, or pauses affected work early when an architectural assumption is false, requirements conflict, public behavior must change, or verification repeatedly fails. The advisor revises affected decisions, chooses the next batch, or recommends completion.

A batch should represent meaningful progress, not a single tool call. This is not a 60/40 token quota. Batch boundaries and consultation checkpoints are prompt-guided rather than automatically detected or enforced from tool calls.

## Optional planning enforcement

Enable cloud access and enforcement separately:

```text
/omni-advisor on
/omni-advisor planning on
```

For each new user prompt, execution tools are blocked until `ask_advisor` successfully returns advice. Local discovery and preparation are allowed through `read`, `grep`, `glob`, `ls`, `find`, `advisor_status`, `advisor_checklist`, `register_masked_terms`, and `ask_advisor`.

Shell, editing, delegation, and unrecognized custom tools remain blocked before planning because they can change state. Successful consultation unlocks execution for the prompt; this is not a separate gate for every cloud-led batch. Pure conversational replies do not require a consultation.

Privacy rejection, missing credentials, cancellation, exhausted limits, and failed/truncated streams do not unlock execution. To explicitly proceed without a plan:

```text
/omni-advisor planning off
```

`/omni-advisor off` blocks cloud requests but does **not** disable planning enforcement. With both cloud-off and enforcement-on, execution stays blocked until you change one of those settings.

Compaction in the same running session preserves approval and the local checklist for its immediate continuation. Fresh interactive/RPC user input starts a new planning stage. A stale response cannot approve a newer prompt. Approval is memory-only and does not survive an extension reload or process restart.

## Recovery and stopping

The local prompt asks the model to keep settled decisions closed unless evidence changes, avoid rerunning passing checks without reason, and stop when required acceptance criteria are supported.

Repeated design reconsideration should lead to one targeted local check or one abstract consultation. For testing loops, three reported command/evaluation errors—or three reported edit/write errors on the same file—produce one reassessment hint per task, even if reads/edits occur between failures. The hint survives compaction and resets for a new task.

The recovery question is **whether to continue, simplify verification, or stop**, not merely how to fix the next harness failure. Product defects must be distinguished from harness/tooling defects. If the user will manually verify the browser, the executor should not build a replacement browser simulator.

This is bounded prompt guidance, not automatic execution of a cloud call or a guarantee of model compliance. Detection uses host-reported tool errors; failed assertions inside a successful command may evade it. If advice is unavailable, use a smaller meaningful existing check or report the unverified limit without bypassing enforcement.
