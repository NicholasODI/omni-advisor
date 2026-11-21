# Workflows and planning enforcement

[Documentation](README.md) · [Repository overview](../README.md)

## Choose a workflow

All modes keep file access, tools, implementation, and tests local. Changing a mode does not turn cloud access on.

| Mode | Cloud involvement |
|---|---|
| **Balanced** — default | Initial plan, consequential unsettled decisions, one final abstract review |
| **Local-led** | Initial plan, then focused escalation when needed |
| **Cloud-led** | Proposes one locally approved step at a time from abstract feedback |

Choose a workflow in `/omni-advisor`, or use:

```text
/omni-advisor mode balanced
/omni-advisor mode local-led
/omni-advisor mode cloud-led
```

### Balanced

For nontrivial tasks, the local model gathers facts before requesting a plan. The advisor identifies up to three assumptions that could change its recommendation, with targeted local checks and an approach for each likely result. If the checks settle the choice, the local model proceeds using the applicable recommendation.

If new evidence invalidates the plan or leaves a consequential choice open, the local model sends a focused decision brief with the changed fact, remaining options, and one question. Before completion, it requests one final review of acceptance evidence and residual risks, with outcomes marked passed, failed, or unverified. The advisor identifies the most consequential gap and the smallest check that would close it, or recommends stopping if the evidence supports completion.

Trivial tasks stay local. There is no required mid-task call if the original plan already settles the decision. Final-review gaps are addressed locally; another review needs materially new architectural evidence. Routine syntax, commands, debugging, and tests do not require cloud supervision.

If OMP sees a successful edit or write and the turn reaches a normal stop without a review of the current changes, Omni Advisor can give the local model one optional review reminder before the session settles. The reminder starts no cloud request itself. It respects the current workflow, cloud access, user scope, tool availability, and consultation budget. A previously completed review becomes stale after another observed edit or write. Read-only work and changes made only through shell commands do not trigger this reminder. The local model can finish without a consultation if a review is unnecessary.

### Local-led

The local model executes the initial plan and consults again for a material discrepancy, consequential uncertainty, or a stalled approach. This is the lighter option when the local executor handles independent work well.

### Cloud-led

With cloud access on, the first `ask_advisor` call requests a single step using an abstract task brief. The advisor supplies a step category, objective, constraints, and success check. Omni Advisor validates the proposal against user scope, then permits local work only in that category.

| Step | Local work allowed |
|---|---|
| `inspect` | Read and search tools |
| `edit` | Read, search, edit, and write tools |
| `shell` | Read and search tools, plus foreground shell work such as a build or test |
| `finish` | Report completion or the remaining blocker based on local evidence |

Status, checklist, recovery, masking, and consultation tools remain available subject to user authorization and the planning gate. The local executor chooses the actual files, commands, and arguments. The gate constrains tool categories. Existing OMP permissions and local judgment govern the meaning and effects of a command.

After the active step's tools finish, call `ask_advisor` with its `cloudStepId` and at least one abstract outcome. The extension closes that step while it waits for a new valid proposal. If the request fails, any deliberate retry uses the same ID and abstract outcomes. A step can include several local tool calls. An unverified or failed check can send a finish step back for revision. When the model can finish or needs outside input, it can respond to the user directly.

This gate rejects explicit background and service launches through OMP's shell tool. If OMP automatically backgrounds a shell call, wait for it to settle and start a fresh user turn before continuing. Step approvals survive immediate compaction and reset on a fresh task, session navigation, mode change, or restart. Use `advisor_status` to recover the active step ID. Turning cloud access off discards the approval. Optional planning enforcement still applies independently.

## Optional planning enforcement

Enable cloud access and enforcement separately:

```text
/omni-advisor on
/omni-advisor planning on
```

For each new user prompt, execution tools are blocked until `ask_advisor` successfully returns advice. Local discovery and preparation are allowed through `read`, `grep`, `glob`, `ls`, `find`, `advisor_status`, `advisor_checklist`, `register_masked_terms`, and `ask_advisor`.

Shell, editing, delegation, and unrecognized custom tools remain blocked before planning because they can change state. Successful consultation unlocks that planning gate for the prompt. Cloud-led mode also requires an approved step in the appropriate tool category. Pure conversational replies do not require a consultation.

Privacy rejection, missing credentials, cancellation, exhausted limits, and failed/truncated streams do not unlock execution. To explicitly proceed without a plan:

```text
/omni-advisor planning off
```

`/omni-advisor off` blocks cloud requests but does **not** disable planning enforcement. With both cloud-off and enforcement-on, execution stays blocked until you change one of those settings.

Compaction in the same running session preserves approval and the local checklist for its immediate continuation. Fresh interactive/RPC user input starts a new planning stage. A stale response cannot approve a newer prompt. Approval is memory-only and does not survive an extension reload or process restart.

## Recovery and stopping

The executor keeps settled decisions closed unless evidence changes and stops when required acceptance criteria are supported. Repetitive failures now use [persistent, evidence-aware recovery control](recovery.md).

The default is **observe**: record similar failures and request one short decision at a configurable threshold. Optional **enforce** mode blocks only the repeated operation while allowing inspection and a recorded one-shot diagnostic/remedy. Cloud advice is optional; the local model can record a hypothesis or external blocker without network access. State survives compaction/resume and resets only for an explicit unrelated-task transition.

Recovery never weakens acceptance criteria or runs broader tests automatically. Required final gates remain required. See [recovery controls and limitations](recovery.md) for persistence, overrides, and the optional context-forge handoff surface.

Explicit stop and analysis-only requests now have [persistent tool-authorization controls](recovery.md#user-authorization-takes-precedence). Todo reminders do not resume stopped work. Wrap-up requests freeze scope in guidance and restrict unrequested destructive cleanup; required final verification is still required.
