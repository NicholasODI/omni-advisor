import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "omni-cloud-led-"));
const fetchBefore = globalThis.fetch;
try {
  for (const name of ["index.ts", "package.json", "src"]) {
    cpSync(new URL(`../${name}`, import.meta.url), join(fixture, name), { recursive: true });
  }
  writeFileSync(join(fixture, "omni-advisor.config.json"), JSON.stringify({
    enabledByDefault: true,
    executionMode: "cloud-led",
    advisorModel: "example/model",
    recoveryMode: "disabled",
    providers: { example: { baseUrl: "https://example.com/v1", api: "openai", stream: false } },
  }));
  const { default: extension } = await import(pathToFileURL(join(fixture, "index.ts")).href);
  const hooks: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const entries: Array<{ type: string; data: unknown }> = [];
  const zod: any = new Proxy(() => zod, { get: () => zod, apply: () => zod });
  extension({
    zod,
    on: (name: string, handler: unknown) => { hooks[name] = handler; },
    registerTool: (tool: { name: string }) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: unknown) => { commands[name] = command; },
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
  });
  const ctx = { sessionManager: { getSessionFile: () => "/synthetic/cloud-led" }, ui: { notify() {} } };
  const turn = { reason: "prompt", prompt: "Synthetic worker task", systemPrompt: [] };
  const proposal = (kind: string) => ({
    kind,
    objective: "Advance the synthetic worker task",
    constraints: "Preserve existing acceptance criteria.",
    successCheck: "The expected abstract outcome is confirmed.",
  });
  const requests: any[] = [];
  let nextResponse = JSON.stringify(proposal("inspect"));
  let pause: Promise<void> | undefined;
  let providerFails = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://example.com/v1/chat/completions");
    requests.push(JSON.parse(String(options?.body)));
    await pause;
    if (providerFails) return new Response(null, { status: 503 });
    return Response.json({ choices: [{ message: { content: nextResponse }, finish_reason: "stop" }] });
  };
  const ask = (extra: Record<string, unknown> = {}) =>
    tools.ask_advisor.execute("", { objective: "Improve a synthetic worker", questions: "What is the next step?", ...extra }, undefined, undefined, ctx);
  const call = (toolName: string, toolCallId = toolName, input = {}) =>
    hooks.tool_call({ toolName, toolCallId, input }, ctx);
  const finishTool = (toolName: string, toolCallId = toolName, details = {}) =>
    hooks.tool_result({ toolName, toolCallId, details, isError: false, input: {}, content: [] }, ctx);
  const status = async () =>
    (await tools.advisor_status.execute("", {}, undefined, undefined, ctx)).details.cloudLed;
  const report = (step: { id: string }, status = "passed") => ({
    cloudStepId: step.id,
    outcomes: [{ check: "Verify worker outcome", status, summary: "Local abstract result is available." }],
  });

  await hooks.before_agent_start(turn, ctx);
  assert.equal((await call("read")).block, true, "Inspecting work needs a step too");
  assert.equal((await call("write")).block, true);
  assert.equal(await call("advisor_status"), undefined);
  nextResponse = JSON.stringify({ ...proposal("shell"), command: "synthetic command" });
  assert.equal((await ask()).details.status, "cloud-step-rejected");
  assert.equal((await status()).activeStep, null);
  nextResponse = JSON.stringify([proposal("inspect"), proposal("edit")]);
  assert.equal((await ask()).details.status, "cloud-step-rejected");

  nextResponse = JSON.stringify(proposal("inspect"));
  const inspect = (await ask()).details.cloudStep;
  assert.equal(inspect.kind, "inspect");
  assert.match(requests.at(-1).messages[0].content, /exactly one JSON object/);
  assert.equal(requests.at(-1).tools, undefined);
  assert.equal((await call("bash")).block, true);
  assert.equal((await call("edit")).block, true);
  assert.equal(await call("read", "read-1"), undefined);
  assert.equal((await ask(report(inspect))).details.status, "cloud-step-required");
  await finishTool("read", "read-1");
  const beforeInvalidReport = requests.length;
  assert.equal((await ask()).details.status, "cloud-step-required");
  assert.equal((await ask({ ...report(inspect), cloudStepId: "wrong-step" })).details.status, "cloud-step-required");
  assert.match((await ask({ ...report(inspect), objective: "password: synthetic-only" })).content[0].text, /Privacy check/);
  assert.equal(requests.length, beforeInvalidReport);
  assert.equal((await status()).activeStep.id, inspect.id);

  nextResponse = JSON.stringify(proposal("edit"));
  const delayed = Promise.withResolvers<void>();
  pause = delayed.promise;
  const next = ask(report(inspect));
  assert.equal((await status()).activeStep, null);
  assert.equal((await call("read")).block, true);
  assert.equal((await ask(report(inspect))).details.status, "budget");
  delayed.resolve();
  pause = undefined;
  const edit = (await next).details.cloudStep;
  assert.equal(edit.kind, "edit");
  assert.notEqual(edit.id, inspect.id);
  assert.match(requests.at(-1).messages[1].content, /Local abstract result is available/);
  assert.equal(JSON.stringify(requests.at(-1)).includes(inspect.id), false);
  assert.equal(await call("write", "write-1"), undefined);
  await finishTool("write", "write-1");
  await hooks.session_compact({}, ctx);
  await hooks.before_agent_start(turn, ctx);
  assert.equal((await status()).activeStep.id, edit.id);

  providerFails = true;
  await ask(report(edit));
  providerFails = false;
  assert.equal((await status()).activeStep, null);
  assert.equal((await status()).lastReportedStepId, edit.id);
  assert.equal((await call("write")).block, true);
  nextResponse = JSON.stringify(proposal("shell"));
  const shell = (await ask(report(edit))).details.cloudStep;
  assert.equal((await call("write")).block, true);
  assert.equal((await call("bash", "async", { async: true })).block, true);
  assert.equal(await call("bash", "checks"), undefined);
  assert.equal((await ask(report(shell))).details.status, "cloud-step-required");
  await finishTool("bash", "checks");

  nextResponse = JSON.stringify(proposal("finish"));
  const finish = (await ask(report(shell))).details.cloudStep;
  assert.equal(finish.kind, "finish");
  assert.equal((await call("read")).block, true);
  assert.equal((await ask(report(finish))).details.status, "cloud-step-required");
  nextResponse = JSON.stringify(proposal("inspect"));
  assert.equal((await ask(report(finish, "unverified"))).details.cloudStep.kind, "inspect");

  await commands["omni-advisor"].handler("scope analysis", ctx);
  await hooks.before_agent_start(turn, ctx);
  nextResponse = JSON.stringify(proposal("edit"));
  assert.equal((await ask()).details.status, "cloud-step-rejected");
  assert.equal((await call("write")).block, true);
  await commands["omni-advisor"].handler("scope active", ctx);
  nextResponse = JSON.stringify(proposal("shell"));
  const activeShell = (await ask()).details.cloudStep;
  assert.equal(await call("bash", "backgrounded"), undefined);
  await finishTool("bash", "backgrounded", { async: { state: "running" } });
  assert.equal((await ask(report(activeShell))).details.status, "cloud-step-required");
  assert.equal((await status()).backgroundedShell, true);

  await hooks.before_agent_start(turn, ctx);
  const late = Promise.withResolvers<void>();
  pause = late.promise;
  const old = ask();
  await hooks.before_agent_start(turn, ctx);
  late.resolve();
  pause = undefined;
  assert.equal((await old).details.status, "stale");
  assert.equal((await status()).activeStep, null);
  await commands["omni-advisor"].handler("mode balanced", ctx);
  assert.equal(await call("write"), undefined, "Balanced mode keeps its existing tool behavior");

  const stepEntries = entries.filter(entry => entry.type === "omni-advisor.cloud-step.v1");
  assert.equal(stepEntries.filter(entry => (entry.data as any).stepId === edit.id && (entry.data as any).event === "reported").length, 1);
  assert.doesNotMatch(JSON.stringify(stepEntries), /synthetic worker|Local abstract result|password/);
  console.log("Cloud-led steps passed: schema, tool classes, sequential handoff, report privacy, scope, compaction, failure, and stale responses.");
} finally {
  globalThis.fetch = fetchBefore;
  rmSync(fixture, { recursive: true, force: true });
}
