# Maintenance boundaries

Omni Advisor owns consultation, local recovery decisions and selective retry
controls. Context Forge owns project memory and compaction handoffs. There is no
cross-extension import or private shared persistence protocol. Advisor access
remains optional and cloud access stays off by default.

## Internal responsibilities

- `src/extension.ts` wires host tools/hooks to configuration, provider dispatch,
  accounting and session state. It supplies an action adapter for user commands.
- `src/commands/advisorCommand.ts` handles the main command and settings UI through
  explicit actions, without owning configuration files or session maps.
- `src/state/sessionCoordinator.ts` handles recovery identity, input/compaction
  lifecycle signals, restoration and cleanup. Fresh user input takes precedence
  over compaction continuation. Continuation signals are consumed once. Sessions
  without a stable identity remain isolated and memory-only.
- `src/state/recoverySession.ts` owns bounded recovery-session persistence.
- `src/workflow/recoveryEvidence.ts` interprets bounded tool evidence and stable
  operation/failure fingerprints. It does not authorize retries or persist state.
- `src/workflow/recovery.ts` owns episode transitions, one-shot authorization,
  bounded decisions and evidence revisions. Existing public evidence exports are
  retained for compatibility.
- `src/workflow/executionScope.ts` handles explicit execution authorization.

Natural-language authorization recognizes direct English clauses, not quoted
examples or reported mentions. It is deliberately incomplete: use the existing
scope commands/settings for an unambiguous override. Ambiguous statements do not
supply new authorization. Repeated successful checks and separate test targets
must not be treated as the same failing operation.

Recovery entry names, version and bounded persistence are unchanged. Tool output
never becomes a user authorization. New regression counterexamples exercise
quoted/reported stop phrases, negations, distinct targets, repeated successful
checks, incomplete evidence and cross-session continuation isolation.

The refactor expands dense transitions for review; physical line counts can grow
without adding runtime features. Native TypeScript regression execution does not
constitute a whole-extension typecheck or a live OMP/provider compatibility test.
