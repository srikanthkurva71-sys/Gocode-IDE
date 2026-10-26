# Security Model

Gocode IDE must treat source repositories, project settings, build scripts, terminal commands, and third-party extensions as untrusted.

- Use least-privilege Tauri capabilities and narrowly scoped Rust commands.
- Native file open/save is initiated through OS dialogs and text-file APIs; it still requires Windows runtime testing and a scope review.
- The interactive terminal starts a user-visible system shell in desktop builds. Commands are entered by the user; project scripts are not run automatically when a workspace opens.
- Closing the terminal panel requests termination of its PTY session. Process-tree cleanup and cancellation behavior require additional testing.
- External AI/network features require explicit user action and disclosure of provider and data sent.
- Telemetry is off by default. Redact credentials, tokens, environment variables, and secrets from logs.
- Extension manifests are currently review-only declarations, not verified publisher identities or proof of permission safety. Executable extensions remain disabled until a restricted process boundary, capability grants, package validation, and security review are in place. The manifest UI also shows heuristic risk labels for declared capabilities; these labels are advisory only and do not enforce access controls.
- Audit dependencies and review advisories; avoid blind forced upgrades.
- CI now builds the Windows MSI and performs a clean-runner install/launch/uninstall smoke test. This is not a substitute for manual testing on supported Windows versions.

## Current prototype boundary

The native terminal and file dialogs are implemented in the development branch, but are not yet validated on a user's machine. Git operations and initial compiler/toolchain adapters are implemented. LSP and DAP process integrations are experimental, user-configured, and not yet covered by end-to-end adapter tests. Managed terminal, LSP, and DAP child processes are explicitly killed and waited on when their Tauri state is dropped. Executable extension hosting and sandboxing remain disabled. A full security review is still outstanding. This document records requirements and current boundaries; it is not a certification or security guarantee.
