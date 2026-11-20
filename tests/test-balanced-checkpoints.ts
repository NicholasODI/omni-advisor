import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Load the normal extension entry with an isolated config and intercepted provider.
const fixture = mkdtempSync(join(tmpdir(), "omni-balanced-"));
const fetchBefore = globalThis.fetch;
try {
  for (const name of ["index.ts", "package.json", "src"]) {
    cpSync(new URL(`../${name}`, import.meta.url), join(fixture, name), { recursive: true });
  }
  writeFileSync(join(fixture, "omni-advisor.config.json"), JSON.stringify({
    enabledByDefault: true,
    executionMode: "balanced",
    recoveryMode: "disabled",
    maxConsultationsPerSession: 2,
    advisorModel: "example/model",
    providers: { example: { baseUrl: "https://example.com/v1", api: "openai", stream: false } },
  }));
  const { default: extension } = await import(pathToFileURL(join(fixture, "index.ts")).href);
  let requests = 0;
  let waitForProvider: Promise<void> | undefined;
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://example.com/v1/chat/completions");
    const intent = entries.at(-1);
    assert.equal(intent?.type, "omni-advisor.consultations.v1");
    assert.equal(intent.data.receipts.at(-1).outcome, "pending");
    requests++;
    await waitForProvider;
    return Response.json({ choices: [{ message: { content: "Synthetic advice kept out of metadata." }, finish_reason: "stop" }] });
  };

  const hooks: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const entries: Array<{ type: string; data: any }> = [];
  let advisorActive = true;
  const zod: any = new Proxy(() => zod, { get: () => zod, apply: () => zod });
  extension({
    zod,
    on: (name: string, handler: unknown) => { hooks[name] = handler; },
    registerTool: (tool: { name: string }) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: unknown) => { commands[name] = command; },
    getActiveTools: () => advisorActive ? ["ask_advisor"] : [],
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  });
  const newSession = (id: string, branch?: Array<{ type: string; customType: string; data: any }>) => ({
    sessionManager: { getSessionFile: () => `/synthetic/${id}`, getBranch: () => branch ?? [] },
    ui: { notify() {} },
  });
  const turn = { reason: "prompt", prompt: "Synthetic task prompt kept local.", systemPrompt: [] };
  const stop = { last_assistant_message: { role: "assistant", stopReason: "stop" } };
  const edit = {
    toolName: "edit", toolCallId: "edit-1", isError: false,
    input: { path: "/synthetic/private/worker.ts" },
    content: [{ type: "text", text: "Synthetic edit result kept local." }],
  };
  const status = async (ctx: ReturnType<typeof newSession>) =>
    (await tools.advisor_status.execute("", {}, undefined, undefined, ctx)).details.balancedCheckpoints;
  const receipts = async (ctx: ReturnType<typeof newSession>) =>
    (await tools.advisor_status.execute("", {}, undefined, undefined, ctx)).details.consultationReceipts;
  const ask = (purpose: string, ctx: ReturnType<typeof newSession>, objective = "Review an abstract worker") =>
    tools.ask_advisor.execute("", { purpose, objective, questions: "Which checks matter?" }, undefined, undefined, ctx);
  const checkpoints = () => entries.filter(entry => entry.type === "omni-advisor.checkpoints.v1").map(entry => entry.data);

  const skipped = newSession("skipped-review");
  await hooks.before_agent_start(turn, skipped);
  assert.deepEqual(checkpoints().at(-1).startedWith, {
    cloudEnabled: true, mode: "balanced", planningEnforced: false,
  });
  assert.equal(hooks.session_stop(stop, skipped), undefined);
  await hooks.tool_result({ ...edit, isError: true }, skipped);
  assert.equal(hooks.session_stop(stop, skipped), undefined);
  await hooks.tool_result(edit, skipped);
  await hooks.session_compact({}, skipped);
  await hooks.agent_end({ willContinue: true }, skipped);
  await hooks.before_agent_start(turn, skipped);
  assert.equal((await status(skipped)).plan, "due");
  assert.equal((await status(skipped)).decision, "optional");
  assert.equal((await status(skipped)).review, "due");
  const reminder = hooks.session_stop(stop, skipped);
  assert.equal(reminder.continue, true);
  assert.match(reminder.additionalContext, /ask_advisor once with purpose review/);
  assert.equal(requests, 0, "The reminder itself must not call the provider");
  await hooks.agent_end({ willContinue: true }, skipped);
  await hooks.before_agent_start({ ...turn, prompt: reminder.additionalContext }, skipped);
  assert.equal((await status(skipped)).reviewReminderSent, true);
  assert.equal(hooks.session_stop(stop, skipped), undefined);
  await hooks.agent_end({}, skipped);
  assert.deepEqual(checkpoints().map(entry => entry.event), ["started", "review-reminder", "settled"]);
  assert.equal(checkpoints().at(-1).review, "due");

  const reviewed = newSession("completed-review");
  await hooks.before_agent_start(turn, reviewed);
  await hooks.tool_result(edit, reviewed);
  assert.equal((await ask("plan", reviewed)).details.advisor, "example/model");
  assert.equal((await ask("review", reviewed)).details.advisor, "example/model");
  assert.equal((await status(reviewed)).plan, "completed");
  assert.equal((await status(reviewed)).review, "completed");
  assert.equal(hooks.session_stop(stop, reviewed), undefined);

  const rejected = newSession("locally-rejected");
  await hooks.before_agent_start(turn, rejected);
  await hooks.tool_result(edit, rejected);
  assert.match((await ask("review", rejected, "password: synthetic-only")).content[0].text, /Privacy check/);
  assert.equal((await status(rejected)).review, "blocked");
  assert.equal(hooks.session_stop(stop, rejected), undefined);
  assert.equal(requests, 2);

  const exhausted = newSession("budget-exhausted");
  await hooks.before_agent_start(turn, exhausted);
  await hooks.tool_result(edit, exhausted);
  await ask("plan", exhausted);
  await ask("decision", exhausted);
  assert.equal((await status(exhausted)).decision, "completed");
  assert.equal((await status(exhausted)).reviewBlocker, "budget-exhausted");
  assert.equal(hooks.session_stop(stop, exhausted), undefined);

  const unavailable = newSession("inactive-review");
  await hooks.before_agent_start(turn, unavailable);
  await hooks.tool_result(edit, unavailable);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(hooks.session_stop({ ...stop, signal: cancelled.signal }, unavailable), undefined);
  assert.equal(hooks.session_stop({ last_assistant_message: { role: "assistant", stopReason: "error" } }, unavailable), undefined);
  advisorActive = false;
  assert.equal(hooks.session_stop(stop, unavailable), undefined);
  assert.equal((await status(unavailable)).reviewBlocker, "tool-inactive");
  advisorActive = true;
  await hooks.input({ source: "interactive", text: "stop right now" }, unavailable);
  assert.equal(hooks.session_stop(stop, unavailable), undefined);
  assert.equal((await status(unavailable)).reviewBlocker, "user-scope");
  await commands["omni-advisor"].handler("off", unavailable);
  assert.equal(hooks.session_stop(stop, unavailable), undefined);
  assert.equal((await status(unavailable)).reviewBlocker, "cloud-off");
  await hooks.before_agent_start(turn, unavailable);
  assert.equal(checkpoints().at(-1).startedWith.cloudEnabled, false);
  assert.equal((await status(unavailable)).substantiveWork, false);

  assert.equal(requests, 4);

  const revised = newSession("review-after-edit");
  await hooks.before_agent_start(turn, revised);
  await hooks.tool_result(edit, revised);
  const reviewedResult = await ask("review", revised);
  let currentReceipt = (await receipts(revised)).recent.at(-1);
  assert.equal(currentReceipt.id, reviewedResult.details.receiptId);
  assert.equal(currentReceipt.outcome, "completed");
  assert.equal(currentReceipt.freshness, "current");
  assert.ok(currentReceipt.finishedAt >= currentReceipt.startedAt);
  await hooks.tool_result({ ...edit, isError: true }, revised);
  assert.equal((await receipts(revised)).recent.at(-1).freshness, "current");
  await hooks.tool_result(edit, revised);
  assert.equal((await status(revised)).review, "stale");
  assert.equal((await receipts(revised)).recent.at(-1).freshness, "changed-evidence");
  assert.equal(hooks.session_stop(stop, revised).continue, true);

  const late = newSession("late-after-edit");
  await hooks.before_agent_start(turn, late);
  const delayed = Promise.withResolvers<void>();
  waitForProvider = delayed.promise;
  const lateResponse = ask("review", late);
  const receiptBeforeEdit = (await receipts(late)).recent.at(-1);
  assert.equal(receiptBeforeEdit.outcome, "pending");
  const pendingEntry = {
    type: "custom",
    customType: "omni-advisor.consultations.v1",
    data: structuredClone(entries.at(-1)!.data),
  };
  await hooks.tool_result(edit, late);
  delayed.resolve();
  waitForProvider = undefined;
  const staleResponse = await lateResponse;
  assert.equal(staleResponse.details.status, "stale");
  assert.doesNotMatch(staleResponse.content[0].text, /Synthetic advice/);
  currentReceipt = (await receipts(late)).recent.at(-1);
  assert.equal(currentReceipt.outcome, "stale");
  assert.equal(currentReceipt.freshness, "changed-evidence");
  assert.equal((await status(late)).review, "stale");

  const resumed = newSession("interrupted-after-restart", [pendingEntry]);
  const beforeRestore = requests;
  await hooks.session_start({}, resumed);
  currentReceipt = (await receipts(resumed)).recent.at(-1);
  assert.equal(currentReceipt.id, receiptBeforeEdit.id);
  assert.equal(currentReceipt.outcome, "unknown");
  assert.equal(currentReceipt.finishedAt, undefined);
  assert.equal((await receipts(resumed)).persistence, "session-entry");
  await hooks.before_agent_start(turn, resumed);
  assert.equal((await receipts(resumed)).recent.at(-1).freshness, "prior-task");
  assert.equal(requests, beforeRestore, "Restoring an uncertain receipt must not dispatch a request");

  const changedTask = newSession("late-after-new-task");
  await commands["omni-advisor"].handler("planning on", changedTask);
  await hooks.before_agent_start(turn, changedTask);
  const oldPlan = Promise.withResolvers<void>();
  waitForProvider = oldPlan.promise;
  const oldPlanResponse = ask("plan", changedTask);
  await hooks.before_agent_start(turn, changedTask);
  oldPlan.resolve();
  waitForProvider = undefined;
  assert.equal((await oldPlanResponse).details.status, "stale");
  assert.equal((await receipts(changedTask)).recent.at(-1).freshness, "prior-task");
  assert.equal((await status(changedTask)).plan, "not-due");
  assert.equal((await tools.advisor_status.execute("", {}, undefined, undefined, changedTask)).details.awaitingPlan, true);

  const switchFrom = newSession("late-after-session-switch");
  const switchTo = newSession("other-session");
  await hooks.before_agent_start(turn, switchFrom);
  const switched = Promise.withResolvers<void>();
  waitForProvider = switched.promise;
  const switchedResponse = ask("plan", switchFrom);
  await hooks.session_switch({}, switchTo);
  const beforeSettlement = entries.length;
  switched.resolve();
  waitForProvider = undefined;
  assert.equal((await switchedResponse).details.status, "stale");
  assert.equal(entries.length, beforeSettlement, "Never append an old task receipt to the selected session");
  assert.deepEqual((await receipts(switchTo)).recent, []);

  const metadata = JSON.stringify(entries.filter(entry => entry.type !== "omni-advisor.recovery.v1"));
  assert.doesNotMatch(metadata, /Synthetic task prompt|private\/worker|Synthetic edit result|Synthetic advice|synthetic-only/);
  assert.equal(requests, 8);
  console.log("Balanced checkpoints passed: reminders, scope and budget gates, receipt restoration, and stale responses after edits or task and session changes.");
} finally {
  globalThis.fetch = fetchBefore;
  rmSync(fixture, { recursive: true, force: true });
}
