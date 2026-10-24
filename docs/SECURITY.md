# Security Model

Gocode IDE must treat source repositories, project settings, build scripts, terminal commands, and third-party extensions as untrusted.

- Use least-privilege Tauri capabilities and narrowly scoped Rust commands.
- Canonicalize workspace paths; block traversal and unsafe symlink escapes.
- Never execute project scripts automatically on opening a folder.
- Show commands and working directories before execution; support cancellation and exit-code reporting.
- External AI/network features require explicit user action and disclosure of provider and data sent.
- Telemetry is off by default. Redact credentials, tokens, environment variables, and secrets from logs.
- Extension manifests disclose publisher, version, license, permissions, and network access.
- Audit dependencies and review advisories; avoid blind forced upgrades.
- Test clean install, upgrade, uninstall, and user-data preservation.

## Current prototype boundary
The current browser prototype uses browser storage/downloads. Its terminal and native integrations are placeholders. This document specifies intended controls; it is not proof they are implemented.
