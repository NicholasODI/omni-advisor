# omni-advisor

A local executor with a stateless cloud planning advisor. The local model reads files, calls tools, implements, and tests. The cloud receives an abstract planning brief and returns ordered steps, assumptions, edge cases, and verification criteria. Follow-ups should describe only material discrepancies and affected plan excerpts.

## Configuration

Edit `omni-advisor.config.json`, then reload the extension:

```json
{
  "enabledByDefault": false,
  "advisorModel": "openai/gpt-4.1",
  "advisorTimeoutMs": 120000,
  "maxConsultationsPerSession": 3,
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

Set key environment variables securely in the process launching OMP; never commit keys. The config stores variable **names**, not keys. Base URLs must be HTTPS without embedded credentials, query strings, or fragments. The adapter appends `/chat/completions` or `/messages`. Choose a model supported by your provider and this non-streaming text API. Native Anthropic uses `anthropic-version: 2023-06-01`. Model-specific reasoning APIs are not implemented.

Switch with `/omni-advisor model claude/<model-id>` or `/omni-advisor model openrouter/<vendor>/<model-id>`. Provider aliases are arbitrary. `OMNI_ADVISOR_MODEL` overrides the configured selector; the command override takes highest precedence. `OMNI_ADVISOR_FOCUS` overrides focus. Without an explicit provider entry, legacy provider discovery from `~/.omp/agent/models.yml` remains available. Autocomplete and optional quota lookup use legacy providers only.

## Local workflow

Enable cloud consultation with `/omni-advisor on`; `/omni-advisor off` blocks consultation requests. Disabled is the default.

`ask_advisor` accepts `objective`, `questions`, and optional `stack`, `components`, `constraints`, `facts`, `previousPlan`. Describe architecture and behavior using public technical terms and synthetic examples. The combined brief is limited to 12000 characters. Keep the plan locally, execute with local tools, and verify every step. The default budget is three attempted dispatches per session/process; restarting resets it. Only one consultation per session may be pending. Failed dispatch attempts also consume budget to avoid expensive loops.

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
