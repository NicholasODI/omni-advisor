# Configuration and provider setup

[Documentation](README.md) · [Repository overview](../README.md)

## Interactive settings

Run `/omni-advisor` or `/omni-advisor settings`. Navigate with arrow keys and Enter; Escape closes a dialog. Settings group cloud access, workflow, planning enforcement, provider source/model, provider endpoints, and limits/timeouts.

Choices take effect immediately. Closing the menu does not undo earlier choices. **Save current choices as defaults** writes `omni-advisor.config.json` beside the extension's `index.ts`, preserving unrelated settings. Saving does not supply credentials.

Workflow and enforcement choices are session-scoped until saved. Model/source overrides and provider/limit/timeout edits are process-wide until saved. Explicit on/off commands persist the session gate across restarts. Changing workflow never enables cloud access automatically.

## Reuse OMP's models

Run:

```text
/omni-advisor model omp
/omni-advisor on
```

The picker uses the running OMP instance's available models and switches the advisor source to OMP. OMP resolves provider adapters, credentials, and provider headers. Your local executor model does not change.

To select without a picker:

```text
/omni-advisor source omp
/omni-advisor model provider/model-id
```

For a persistent configuration:

```json
{
  "advisorSource": "omp",
  "advisorModel": "provider/model-id",
  "executionMode": "balanced",
  "enabledByDefault": false
}
```

OMP mode needs the host's model registry and `@oh-my-pi/pi-ai` APIs. Provider compatibility depends on the installed OMP version. Missing authentication fails without silently choosing another provider. Transport and authentication behavior are managed by OMP.

## Configure a provider directly

Use the menu's **Provider settings**, or edit `omni-advisor.config.json` and restart OMP. Example for OpenRouter:

```json
{
  "enabledByDefault": false,
  "executionMode": "balanced",
  "advisorSource": "config",
  "advisorModel": "openrouter/vendor/model-id",
  "advisorTimeoutMs": 120000,
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai",
      "apiKeyEnv": "ADVISOR_OPENROUTER_KEY",
      "maxOutputTokens": 4096,
      "stream": true
    }
  }
}
```

Replace `vendor/model-id` with a model ID listed by your provider. The selector's first segment identifies your configured provider alias; everything after it is the provider's model ID.

Set the key securely in the environment of the process launching OMP. The JSON stores the **environment variable name**, never the key. For example, in Bash:

```sh
read -rsp "OpenRouter API key: " ADVISOR_OPENROUTER_KEY
echo
export ADVISOR_OPENROUTER_KEY
omp --trusted-extension /absolute/path/to/omni-advisor/index.ts
```

Use your shell's secure environment mechanism on other platforms. Do not paste credentials into chat, commit them, or enter their values in the settings menu.

| Provider | Base URL | `api` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `openai` |
| Anthropic | `https://api.anthropic.com/v1` | `anthropic` |
| DeepSeek | `https://api.deepseek.com/v1` | `openai` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai` |

Use any alias you like and an appropriate `apiKeyEnv` name for each provider. Base URLs must be HTTPS without embedded credentials, query strings, or fragments. The adapter appends `/chat/completions` or `/messages`; do not include those paths yourself. Native Anthropic uses `anthropic-version: 2023-06-01`. Choose a model compatible with the selected adapter; model-specific reasoning APIs are not implemented.

Set `stream: false` if an endpoint rejects streaming or OpenAI `stream_options`. It will show waiting/elapsed-time updates without provider phase signals. Failed streaming requests are not automatically retried, avoiding duplicate charges.

## Configuration reference

| Field | Default | Meaning |
|---|---|---|
| `enabledByDefault` | `false` | Cloud access for sessions without an explicit gate override |
| `executionMode` | `balanced` | `balanced`, `local-led`, or `cloud-led` |
| `recoveryMode` | `observe` | `disabled`, `observe`, or selective retry `enforce` |
| `recoveryThreshold` | `3` | Similar failures before a decision, integer 2–20 |
| `enforcePlanning` | `false` | Require initial successful advice before execution tools |
| `advisorSource` | `config` | Explicit endpoint/legacy discovery, or `omp` registry |
| `advisorModel` | `codex-lb/gpt-6.1-sol` | `provider/model-id`; configure a provider you can use |
| `advisorTimeoutMs` | `120000` | Request timeout, 1000–300000 milliseconds |
| `maxConsultationsPerSession` | omitted: unlimited | Optional positive integer limiting attempted dispatches |
| `advisorFocus` | none | Abstract domain hint, maximum 1000 characters |
| `semanticTerms` | none | Local values mapped to placeholder categories |
| `providers` | none | Provider aliases and endpoint settings |

Each provider supports `baseUrl`, `api` (`openai`/`anthropic`), optional `apiKeyEnv`, `maxOutputTokens` (256–16384, default 4096), and `stream` (default enabled when progress is used).

Semantic-term categories are `WORKSPACE`, `HOST`, `PERSON_OR_ORG`, `SECRET`, and `OTHER`. Treat any configuration containing raw semantic terms as sensitive local data.

Selector precedence: command/menu override → `OMNI_ADVISOR_MODEL` → config → fallback. `OMNI_ADVISOR_FOCUS` overrides the configured focus. Existing explicit workflow choices remain in effect; changing the default does not override a saved `local-led` selection.

Without an explicit provider entry, config-source mode can discover legacy providers from `~/.omp/agent/models.yml`. Remote model autocomplete and optional gateway quota lookup use legacy providers only. OMP's model picker does not depend on that discovery.
