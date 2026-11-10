# Commands, tools, and troubleshooting

[Documentation](README.md) · [Repository overview](../README.md)

## Commands

| Command | Action |
|---|---|
| `/omni-advisor` or `/omni-advisor settings` | Open interactive settings |
| `/omni-advisor on` / `off` | Enable or block cloud consultations |
| `/omni-advisor status` | Show gate, source/model, workflow, and enforcement |
| `/omni-advisor model omp` | Pick from OMP's available models |
| `/omni-advisor model provider/model-id` | Set a process-lifetime model override |
| `/omni-advisor model clear` | Clear the model override |
| `/omni-advisor source omp` / `source config` | Switch provider source |
| `/omni-advisor mode balanced` / `mode local-led` / `mode cloud-led` | Select workflow for the session |
| `/omni-advisor planning on` / `planning off` | Enable or disable planning enforcement |
| `/omni-advisor recovery disabled` / `observe` / `enforce` | Set recovery mode (process override; save in menu for defaults) |
| `/omni-advisor recovery new-task` | Retire old recovery episodes for unrelated work |
| `/omni-advisor recovery override <id> <reason>` | Record a user-authorized single retry |
| `/omni-usage` | Show token totals, consultation counts, timing, and cached quota if available |
| `/omni-cipher-status` | Show placeholder metadata, not raw mappings |
| `/omni-cipher-clear` | Clear mappings and usage; preserve logs |

Use the settings menu's save action to persist defaults. See [configuration](configuration.md) for scope and precedence.

## Model-facing tools

### `ask_advisor`

The local model constructs the brief and chooses when to call. Enabling a workflow injects instructions; it does not automatically forward a user prompt. Optional enforcement blocks execution tools until initial advice succeeds.

| Field | Limit / purpose |
|---|---|
| `objective` | Required; 3000 characters |
| `questions` | Required; 3000 characters |
| `purpose` | `plan` (default), `decision`, `checkpoint`, `review` |
| `stack` | Public stack/versions; 1000 characters |
| `components` | Abstract roles/relationships; 2000 characters |
| `constraints` | 2000 characters |
| `facts` | Verified abstract facts; 2000 characters |
| `invariants` | Correctness/security properties; 2000 characters |
| `alternatives` | At most two approaches; 1500 characters |
| `previousPlan` | Relevant abstract paraphrase; 2000 characters |
| `outcomes` | Up to eight check/status/summary entries |

Outcome entries use `check` (200 characters), `status` (`passed`, `failed`, `unverified`), and `summary` (500 characters). Never paste raw test output. The combined serialized brief is limited to 12000 characters; focus is limited to 1000.

Only one consultation per session can be pending. There is no count limit by default. An optional `maxConsultationsPerSession` counts attempted dispatches, including failed dispatches, and resets with the process. Local gate/privacy rejections do not consume the dispatch count.

### `advisor_status`

Returns actual extension settings, configuration readiness, planning state, optional limit (`null` = unlimited), counts, and timing. Local only: no authentication refresh or network probe, and no credential values or endpoint URLs. Configuration presence does not establish connectivity. OMP's `cfg://advisor` is a separate feature.

### `advisor_recovery`

Inspect persisted bounded failure evidence, record a short recovery decision and one exact local action, report a blocker, or explicitly start an unrelated task. No network is required. See [recovery control](recovery.md). `ask_advisor` accepts optional local-only `recoveryEpisode` metadata for one advisor request per episode.

### `advisor_checklist`

Store up to 50 requirement IDs, requirements, statuses, and evidence references. Omit `items` to read; supplying items replaces the checklist. A passed item without evidence becomes unverified. This is local-model-reported evidence, not an independent correctness proof, and is never automatically dispatched. When recovery tracking observes a successful edit/write after checklist evidence was recorded, passed entries are conservatively returned as unverified; external changes remain unknown.

### `register_masked_terms`

Register exact local terms with categories `WORKSPACE`, `HOST`, `PERSON_OR_ORG`, `SECRET`, or `OTHER`. These supplement pattern-based masking. Registering a term does not make confidential surrounding prose safe to send.

## Progress and measurements

Status refreshes locally every second without additional cloud requests. The footer uses your OMP theme:

| Phase | Theme color |
|---|---|
| Waiting | Muted |
| Thinking | Warning |
| Answering | Accent |
| Completed | Success |
| Failed | Error |
| Cancelled | Warning |

Thinking appears only after a provider reasoning event; answering appears after answer text starts. Silent processing stays waiting. Signals do not enable reasoning on a model. No reasoning or partial answer content is displayed; the full text plan returns after completion. Failed, truncated, or incomplete streams do not unlock execution.

The footer retains the terminal status until the next consultation or shutdown. Missing theme/footer support falls back to plain tool updates. Actual display depends on the OMP client.

Metrics distinguish successful/failed consultation attempts from local rejections, provider-reported cloud tokens, missing usage reports, cloud latency, cumulative tool duration, and agent wall time. Timings may overlap; wall time is not measured inference time. Missing prices display as unknown. These figures do not establish cost savings without a comparable baseline.

## Troubleshooting

| Symptom | Check |
|---|---|
| Execution blocked after cloud-off | Planning enforcement is separate; turn it off explicitly to proceed without a plan |
| Wrong tool fields or missing settings commands | OMP may have loaded an older copy; check the loaded `index.ts` path and restart after updating |
| Provider not found | Confirm source, provider alias, and config location; use OMP picker to reuse instance settings |
| Missing key variable | Supply the named variable before starting OMP; never paste the key into chat |
| Rejected abstract brief | Read the field/category error and rephrase; synthetic code/records may still match rejection rules |
| Streaming unsupported | Set `stream: false` for that configured provider; no automatic charged retry is performed |
| No thinking label | Provider may not expose reasoning events; waiting alone is not a failure |
| Blocked after compaction/reload | Immediate same-process compaction is preserved; reload/restart loses in-memory approval |
| Repeated test failures | Reassess product vs harness failure and stay within the user's testing scope |
