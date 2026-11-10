# omni-advisor

Give your local model a cloud planning partner. The local model inspects files, runs tools, implements changes, and tests. The cloud advisor reasons about abstract architecture, design decisions, edge cases, and verification outcomes.

## Features

- **Balanced workflow by default:** cloud planning, advice on consequential decisions, and a final abstract review.
- **Optional workflows:** lighter local-led execution or cloud-led work batches.
- **Flexible providers:** reuse OMP's models and credentials, or configure OpenAI-compatible and native Anthropic endpoints.
- **Interactive settings:** choose models, workflow, planning enforcement, and limits from one terminal menu.
- **Privacy checks:** abstract-only briefs, local validation, identifier masking, and memory-only cipher mappings.
- **Execution support:** optional planning gates, persistent recovery controls, token/timing metrics, and colored progress updates.

## Setup

1. Install [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) and configure your local executor model.
2. Clone this repository:

   ```sh
   git clone https://github.com/NicholasODI/omni-advisor.git
   ```

3. Start OMP with the extension, using the absolute path to your checkout:

   ```sh
   omp --trusted-extension /absolute/path/to/omni-advisor/index.ts
   ```

4. Run `/omni-advisor` to open settings. Choose **OMP instance** as the advisor source, select an available cloud model, and turn **Cloud access** on. The executor model stays unchanged.
5. Select **Save current choices as defaults** if you want to keep these settings.

No dependency installation is needed for this extension. If you prefer to configure a provider directly, follow the [provider setup guide](docs/configuration.md#configure-a-provider-directly). Restart OMP after updating extension files.

## Before you use it

Cloud access is **off by default**. Enabling it sends abstract consultation briefs to your selected provider and may incur charges. Files, history, and tool outputs are not attached automatically.

Privacy checks are heuristic: **they cannot guarantee zero disclosure**, especially for confidential meaning in prose. Keep sensitive details local. Cloud advice is unverified guidance and must be checked locally. See [privacy and limitations](docs/privacy.md).

## Documentation

- [Configuration and provider setup](docs/configuration.md)
- [Workflows and planning enforcement](docs/workflows.md)
- [Commands, tools, progress, and troubleshooting](docs/usage.md)
- [Recovery controls](docs/recovery.md)
- [Privacy and limitations](docs/privacy.md)
- [Development and testing](docs/development.md)
