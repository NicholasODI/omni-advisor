import assert from "node:assert/strict";
import { userScope } from "../src/workflow/executionScope.ts";
import {
  RecoveryController,
  classify,
  operationKey,
} from "../src/workflow/recovery.ts";
import { SessionCoordinator } from "../src/state/sessionCoordinator.ts";

for (const scope of ["active", "paused", "analysis", "closure"] as const) {
  const state = { scope };
  for (const text of [
    "What does stop mean?",
    'The log says "just stop".',
    "The documentation says wrap this up.",
    "Do not stop testing.",
    "Explain why we should not code yet.",
    'If I say "implement", what happens?',
    "The prompt includes just stop as an example.",
  ]) {
    assert.deepEqual(userScope(state, text), state, text);
  }
}
assert.equal(
  userScope({ scope: "active" }, "Please stop right now").scope,
  "paused",
);
assert.equal(
  userScope({ scope: "active" }, "Can you wrap this up?").scope,
  "closure",
);
assert.equal(
  userScope({ scope: "active" }, "Inspect first. Do not implement.").scope,
  "analysis",
);

const controller = new RecoveryController();
const failed = {
  isError: true,
  content: [{ type: "text", text: "AssertionError: expected a value" }],
};
controller.observe("a", "bash", { command: "pnpm test -- alpha" }, failed);
controller.observe("b", "bash", { command: "pnpm test -- beta" }, failed);
assert.equal(controller.snapshot().episodes.length, 2);
assert.equal(
  controller.snapshot().episodes.every((e) => e.attempts === 1),
  true,
);
assert.notEqual(
  operationKey("bash", { command: "pnpm test -- alpha" }),
  operationKey("bash", { command: "pnpm test -- beta" }),
);
// Repeated successful checks are legitimate confirmation, not a stall.
for (let i = 0; i < 5; i++) {
  const input = { command: "pnpm test -- alpha" };
  assert.equal(controller.start(`pass-${i}`, "bash", input, true), undefined);
  controller.observe(`pass-${i}`, "bash", input, {
    content: [{ type: "text", text: "2 passed" }],
  });
}
assert.equal(controller.snapshot().episodes[0].phase, "resolved");
assert.equal(
  classify(
    "bash",
    { command: "pnpm test" },
    { content: [{ type: "text", text: "0 tests" }] },
  )!.outcome,
  "unrun",
);
assert.equal(
  classify(
    "bash",
    { command: "pnpm test" },
    { content: [], details: { exitCode: 0 } },
  )!.outcome,
  "unknown",
);

const sessions = new SessionCoordinator(
  (ctx) => ctx.sessionManager.getSessionFile?.() ?? "unknown",
);
const one = { sessionManager: { getSessionFile: () => "one" } };
const two = { sessionManager: { getSessionFile: () => "two" } };
sessions.compact(one);
assert.equal(sessions.beginsTask(two, "prompt"), true);
assert.equal(sessions.beginsTask(one, "prompt"), false);
assert.equal(sessions.beginsTask(one, "prompt"), true); // consumed exactly once
sessions.compact(one);
sessions.input(one, "inspect only");
assert.equal(sessions.beginsTask(one, "prompt"), true); // real user input wins
assert.equal(sessions.beginsTask(one, "revive"), false);
const unknownA = { sessionManager: {} },
  unknownB = { sessionManager: {} };
assert.notEqual(sessions.recoveryKey(unknownA), sessions.recoveryKey(unknownB));
sessions.recovery(unknownA).setScope("paused");
assert.equal(sessions.recovery(unknownB).snapshot().scope, undefined);
sessions.forget(unknownA);
assert.equal(sessions.recovery(unknownA).snapshot().scope, undefined);
console.log(
  "Maintenance counterexamples passed: authorization mentions, distinct targets, legitimate rechecks, evidence, session isolation and continuation.",
);
