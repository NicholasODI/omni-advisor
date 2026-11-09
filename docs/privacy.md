# Privacy and limitations

[Documentation](README.md) · [Repository overview](../README.md)

## What the cloud receives

A consultation contains advisor instructions and one abstract brief. OMP/provider APIs may represent the instructions as a system message or separate system field. No files, conversation history, tools, diffs, raw tool output, or local checklist evidence are attached automatically.

The allowed policy is **abstract architecture, constraints, synthetic examples, and summarized outcomes**. Useful context includes component roles and relationships, trust boundaries, state transitions, invariants, ordering, scale ranges, public platform versions, failure modes, and acceptance criteria.

Do not send private records, credentials, proprietary code/business rules, identifying details, raw errors/logs, the original user prompt, or internal deliberation. Use neutral roles and fictional prose examples, not renamed copies of confidential content. If a private detail determines the recommendation, keep that decision local and state the unresolved assumption.

The provider also receives the configured model selection and authentication needed to process the request. Provider/account retention policies are outside the extension's control.

## Local safeguards

- Selected brief fields, outcome summaries, and focus are validated before dispatch. Both adapters recheck outbound brief and focus.
- Recognizable credentials, personal identifiers, internal network identifiers, paths, code blocks/declarations, raw JSON/XML, and trace output are rejected with field/category errors that do not echo values.
- Registered terms and supported identifier patterns are masked to `OMNI_*` placeholders as a secondary safeguard. Returned advice keeps placeholders unresolved.
- Unknown top-level tool metadata and extra nested record fields are not serialized into the brief.
- Cloud-off blocks consultation requests. Config-source HTTP requests require HTTPS and reject redirects; OMP-source transport is handled by OMP's provider adapter.
- Progress updates contain only phases and elapsed time, never reasoning content, partial advice, or brief contents.

Masking is pseudonymization, **not encryption**. Base64 detection requires mixed-case letters and digits to avoid treating ordinary slash-separated state names as secrets. Do not rely on entropy detection alone; local abstraction remains essential.

## What stays on disk or in memory

Cipher mappings stay in process memory and are forgotten at session shutdown. Legacy cipher sidecars are not read or written. Old sidecars and historical logs are not automatically migrated or deleted.

New extension request/response logs record sizes and metadata rather than payload bodies; term-registration logs do not record raw values. Usage and gate state have local persistence. Checklists are memory-only, reset for new prompts, and survive the immediate compaction continuation.

The config file can contain sensitive raw `semanticTerms`; protect it accordingly. Store API keys in environment variables, not the config or repository. Protect any OMP session transcripts and host logs too: this extension does not control how the host records tool arguments or user messages.

## What these safeguards cannot prove

Heuristics cannot reliably recognize confidential meaning in prose, unregistered identifiers, encoded/obfuscated data, or every novel secret format. They can also reject harmless content. Rephrase abstractly instead of assuming that successful validation proves safety.

The local model decides what to include. Cloud-led mode creates more consultation opportunities; its privacy boundary is the same, not a stronger confidentiality guarantee. None of the modes guarantees zero disclosure.

Cloud advice is untrusted guidance. Verify assumptions against local facts and public documentation. Research directives are suggestions, not authority to run commands or disclose information. If no user-derived information may leave the device, keep cloud access off.
