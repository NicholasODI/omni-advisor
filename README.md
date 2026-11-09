# omni-advisor

A local executor with a stateless cloud planning advisor. The local model reads files, calls tools, implements, and tests. The cloud receives an abstract planning brief and returns ordered steps, assumptions, edge cases, and verification criteria. Follow-ups should describe only material discrepancies and affected plan excerpts.

## Configuration

Edit `omni-advisor.config.json`, then reload the extension:

```json
{
  "enabledByDefault": false,
  "advisorModel": "openai/gpt-4.1",
  "advisorTimeoutMs": 120000,
  "providers": {
    "openai": { "baseUrl": "https://api.openai.com/v1", "api": "openai", "apiKeyEnv": "ADVISOR_OPENAI_KEY" },
    "claude": { "baseUrl": "https://api.anthropic.com/v1", "api": "anthropic", "apiKeyEnv": "ADVISOR_ANTHROPIC_KEY", "maxOutputTokens": 4096 },
    "deepseek": { "baseUrl": "https://api.deepseek.com/v1", "api": "openai", "apiKeyEnv": "ADVISOR_DEEPSEEK_KEY" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "api": "openai", "apiKeyEnv": "ADVISOR_OPENROUTER_KEY" }
  },
  "advisorFocus": "",
  "semanticTerms": {}
}
```

Set key environment variables securely in the process launching OMP; never commit keys. The config stores variable **names**, not keys. Base URLs must be HTTPS without embedded credentials, query strings, or fragments. The adapter appends `/chat/completions` or `/messages`. Choose a model supported by your provider and this text API. Native Anthropic uses `anthropic-version: 2023-06-01`. Model-specific reasoning APIs are not implemented.

Switch with `/omni-advisor model claude/<model-id>` or `/omni-advisor model openrouter/<vendor>/<model-id>`. Provider aliases are arbitrary. `OMNI_ADVISOR_MODEL` overrides the configured selector; the command override takes highest precedence. `OMNI_ADVISOR_FOCUS` overrides focus. Without an explicit provider entry, legacy provider discovery from `~/.omp/agent/models.yml` remains available. Autocomplete and optional quota lookup use legacy providers only.

## Local workflow

Enable cloud consultation with `/omni-advisor on`; `/omni-advisor off` blocks consultation requests. Disabled is the default.

`ask_advisor` accepts `objective`, `questions`, and optional `stack`, `components`, `constraints`, `facts`, `previousPlan`. Describe architecture and behavior using public technical terms and synthetic examples. The combined brief is limited to 12000 characters. Keep the plan locally, execute with local tools, and verify every step. There is no consultation-count limit by default. Optionally set `maxConsultationsPerSession` to a positive integer; the attempted-dispatch count resets on process restart. Only one consultation per session may be pending. Failed dispatch attempts also consume budget to avoid expensive loops.

Cloud responses retain placeholders and are untrusted guidance, never executable authority. The extension forwards cancellation, bounds time/output, rejects redirects, and records provider-reported advisor token usage. Missing prices remain unpriced; displayed zero does not establish free usage.

## Privacy boundary

No files, history, or tools are attached automatically. Dynamic briefs and focus pass a local heuristic check and masking before dispatch. Code fences, obvious credential assignments, URLs, and common local paths are rejected. This is **not** a proof that arbitrary prose is free of confidential information. Do not include private records, proprietary code, business secrets, or identifying details. The local model must abstract these before consultation.

`register_masked_terms` adds project-specific terms. Request/response logs record sizes; registration logs do not record raw values. Cipher sidecars still retain raw mappings locally in private files. Existing logs and sidecars from older versions are not migrated or deleted; protect or remove those separately. Masking is pseudonymization, not encryption.

Commands: `/omni-advisor on|off|status|model`, `/omni-cipher-status` (placeholder metadata only), `/omni-cipher-clear` (clears mappings and usage, preserves logs), `/omni-usage`.

## Tests

Node >=23.6 (Node 24 recommended), no dependency installation:

```
node test-omni-masker.ts
node test-planning.ts
```

Tests write to the normal `~/.omp` log directory. Provider tests intercept fetch locally; live provider credentials and OMP integration require separate validation.

## Choose a model from the running OMP instance

Run `/omni-advisor model omp` to open a picker of the current instance's available models. Selection switches the advisor source to OMP and reuses its model registry, provider adapters, credentials, and provider headers. The main executor model is unchanged. The completion receives only the advisor system prompt and one abstract brief, with no tools or session history. Existing cloud gate, privacy checks, and consultation budgets still apply.

For persistent selection set `"advisorSource": "omp"` and `"advisorModel": "provider/model-id"` in the config. For temporary selection use `/omni-advisor source omp` followed by `/omni-advisor model provider/model-id`. Return to explicit endpoint configuration with `/omni-advisor source config`. Command source/model overrides last for the process. OMP mode requires the host's `@oh-my-pi/pi-ai` package and registry APIs; unsupported/missing authentication fails without falling back to another provider. Endpoint transport, authentication refresh, and provider-specific behavior are managed by OMP in this mode. Provider support depends on the installed OMP version.

Additional standalone adapter test: `node test-omp-advisor.ts`. Live OMP integration is not covered by these mock tests.

## Optional enforced planning stage

Set `"enforcePlanning": true` in the configuration and reload OMP, or run:

```
/omni-advisor on
/omni-advisor planning on
```

For each new user prompt, execution tools are blocked until `ask_advisor` successfully returns a plan. The local model is instructed to inspect locally, prepare an abstract brief, and consult before executing. Only `read`, `grep`, `glob`, `ls`, `find`, `advisor_status`, `advisor_checklist`, `register_masked_terms`, and `ask_advisor` are allowed before planning. Shell and delegation are deliberately blocked because they can modify state. Custom discovery tools are blocked too. Successful advice unlocks execution only for the current prompt; stale results from an older prompt cannot unlock a newer one.

Cloud enablement is separate: enforcement never turns cloud access on or forwards your prompt automatically. Privacy rejection, missing credentials, cancellation, and exhausted consultation budget do not unlock execution. Use `/omni-advisor planning off` to explicitly continue locally when blocked. Runtime enforcement overrides are session-scoped. `/omni-advisor status` shows enforcement state.

This opt-in mode gates tools for every user prompt, rather than guessing which tasks are nontrivial. Pure conversational replies do not require a consultation. Any configured `maxConsultationsPerSession` must cover the intended multi-prompt workflow. Enforcement depends on OMP's `tool_call` hook and cannot guarantee that the model produces a high-quality abstract brief; existing heuristic privacy limitations still apply.

Test: `node test-planning-gate.ts`.


## Local diagnostics and execution evidence

`advisor_status` returns actual extension settings, provider configuration readiness (not a connectivity guarantee), pending planning state, optional count limit (`null` means unlimited), and current-process session measurements. It never refreshes authentication or makes a network call. It reports no API keys or endpoint URLs. Use this tool instead of inferring settings from OMP's unrelated `cfg://advisor` feature.

`advisor_checklist` stores up to 50 compact requirement IDs, requirements, statuses, and evidence references locally in memory. Omit `items` to inspect it; supplying items replaces the checklist. A passed item without evidence becomes unverified. Checklists reset on each user prompt and are never automatically dispatched. This is self-reported evidence, not an independent correctness proof. The local prompt requires reconciling requirements, tests, and contradictions before claiming completion.

Metrics separate successful and failed consultation attempts from locally blocked calls, provider-reported cloud tokens, missing usage reports, cloud latency, cumulative tool duration, and agent wall time. Timings can overlap; agent wall time is not an inference-time estimate. Tool timing uses host tool-call/result hooks; no tool inputs or outputs are recorded by this instrumentation. Unknown provider prices are displayed as unknown. The third consecutive error for the same tool triggers a local recovery hint rather than an automatic cloud call.

Privacy errors identify the brief field and category without echoing values. Base64 detection now requires mixed-case letters and digits to avoid masking slash-separated state names; explicit known credential patterns and registered terms remain active. This heuristic can still miss secrets: abstract sensitive details locally and register sensitive values rather than relying on entropy detection alone.

Regression checks: `node test-improvements.ts`.


## Local decision-loop recovery

When the advisor is enabled, the local system-prompt nudge asks the executor to stop revisiting the same implementation decision twice without new evidence. It should first use one targeted local check when sufficient; otherwise it can make one abstract consultation for a consequential unresolved choice. The brief includes at most two candidates and asks for a recommendation, next action, and acceptance check—not a transcript of internal deliberation. The executor records the choice locally and proceeds, reopening it only after contradictory evidence. Disabled cloud access, configured limits, and enforced planning remain respected.

This is prompt guidance, not automatic detection of internal reasoning or an automatic network call. Ordinary local debugging stays local. If cloud advice is unavailable, the model should test a safe reversible choice or report a blocker rather than loop indefinitely.


Compaction in the same running session preserves the current planning approval and local checklist for the immediate continuation. A fresh interactive/RPC user input still starts a new planning stage, even if compaction occurred. Compaction does not grant approval where none existed. Approval is held in process memory; restarting/reloading the extension is not covered by this preservation.

## Consultation progress

`ask_advisor` emits local tool-progress updates through OMP's update callback: after brief validation, every five seconds while awaiting completion, and on completion/failure/cancellation. Waiting time includes provider authentication, network latency, and model processing; the extension cannot distinguish those phases or report a completion percentage. Updates contain elapsed time and status only, never briefs, credentials, or partial model output. This works with configured endpoints and OMP-backed advisors with provider streaming where supported. Display depends on the OMP client's tool-progress rendering. Test with `node test-advisor-progress.ts`.


### Provider phase status

Configured OpenAI-compatible/Anthropic endpoints now request streaming for progress. OMP mode consumes its provider stream events. The UI shows **thinking** only when a provider emits a reasoning/thinking event and **answering** when answer text begins. It otherwise remains waiting; silent processing is never labeled thinking by elapsed time alone. Heartbeats retain the last observed phase. No reasoning content or partial answer text is shown in progress updates; the completed text plan is returned at the end. Failed, truncated, or incomplete streams do not unlock execution.

For a configured endpoint that rejects streaming or `stream_options`, set `"stream": false` in its provider entry to use buffered completion with waiting/elapsed-time updates. There is no automatic retry that could duplicate a charged request. OMP streaming support depends on its installed provider adapter. Provider phase signals do not enable reasoning on models that have it disabled. Tests: `node test-advisor-stream.ts`.
