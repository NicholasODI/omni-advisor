# omni-advisor

Local-first pipeline around an isolated, text-only cloud advisor — domain-agnostic (unlike
`ns-advisor`, which is NetSuite-specific). The local model does all work; the cloud model only
sees a **masked** two-message exchange and no file or session context.

## Privacy model

- Every outbound query passes through a lossless masking cipher (`OMNI_*` placeholders);
  the local model receives the **unmasked** advice back.
- Exactly two messages reach the cloud per call: advisor system prompt + masked query.
  No history, no tools, no local files.
- Per-session append-only debug logs at `logs/<session>.debug.log`; cipher mapping and
  usage sidecars at `logs/<session>.cipher.json` / `logs/<session>.usage.json`.
  Masked emails are used for log lines; semantic registration stores raw values so the
  round-trip stays lossless.

## Tools

| Tool | Purpose |
|---|---|
| `ask_advisor` | Send a masked planning/dilemma query to the cloud advisor |
| `register_masked_terms` | Register project-specific values the regex patterns can't see (workspaces, hosts, people/orgs, secrets) |

## Commands

- `/omni-advisor on|off|status|model` — session gate + advisor model selection
- `/omni-advisor model <name>` — switch advisor model (matches provider/model or label prefix)
- `/omni-direct <query>` — bypass gate and local nudge, straight to the advisor
- `/omni-usage` — per-model tokens/cost for the session
- `/omni-mask-status` — placeholder count, mapping size, log path
- `/omni-mask-clear` — drop the in-session mask set

## Config

`omni-advisor.config.json`:

| Field | Meaning |
|---|---|
| `enabledByDefault` | Gate state for new sessions (persisted per session in `logs/omni-advisor-gates.json`) |
| `advisorModel` | Default cloud advisor, e.g. `codex-lb/gpt-6.1-sol` |
| `advisorFocus` | Free text appended to the advisor system prompt as a DOMAIN FOCUS paragraph |
| `semanticTerms` | `{"value": "TYPE"}` auto-registered once per session; types: `WORKSPACE`, `HOST`, `PERSON_OR_ORG`, `SECRET`, `OTHER` |

Env overrides: `OMNI_ADVISOR_MODEL`, `OMNI_ADVISOR_FOCUS` (env beats config).

The gateway resolves the advisor's provider block from `~/.omp/agent/models.yml`
(`baseUrl` + optional `apiKey`); the provider must expose an OpenAI-compatible
`/chat/completions` endpoint.

## Files

- `index.ts` — extension entry: tools, commands, event hooks (nudge, usage tracking, shutdown summary)
- `cipher.ts` — two-layer masker: deterministic patterns (emails, JWTs, vendor/AWS/Slack/Google keys, high-entropy hex/base64, SSH keys, UUIDs, cards, KV secrets, URL creds, home dirs) + semantic registered terms
- `cloudAdvisor.ts` — prompt blocks (executor nudge, advisor system block, advisory frame, response frame)
- `advisorDispatch.ts` — stateless POST to the gateway gateway, 2-message payload, temperature 0.3, max_tokens 4096
- `gateway.ts` — provider parsing + /usage quota check
- `usageTracker.ts` — token/cost accounting with sidecar persistence
- `logger.ts` — append-only session logs, safe session IDs, email masking
- `test-omni-masker.ts` — smoke test (no network)

## Test

```
bun test-omni-masker.ts
```