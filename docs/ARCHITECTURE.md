# Gocode IDE — Architecture and Product Requirements

Status: planning baseline. The presence of a requirement in this document does not mean it is implemented or tested.

## Product commitments
- Free to use: no Gocode IDE subscriptions, ads, or paid feature tiers.
- No mandatory account or OTP. Core editing and local workflows must work offline after installation.
- Local-first privacy. Never upload projects automatically. External AI/cloud calls must be optional, explain the provider and data sent, and require an explicit user action.
- External providers may have separate terms or charges; Gocode IDE itself does not charge users.
- Prefer free/open-source extensions, while disclosing publisher, license, provenance, permissions, and whether the extension is actually open source.
- Never silently execute project scripts, install toolchains, or request elevated privileges.
- Preserve user data during updates and recover gracefully from crashes.

## Proposed stack
- Windows desktop shell: Tauri 2.
- UI: React + TypeScript + Vite.
- Native platform services: Rust with narrowly scoped, permission-checked commands.
- Editor: Monaco candidate; validate performance, accessibility, startup size, and offline operation before locking.
- Language intelligence: Language Server Protocol (LSP).
- Debugging: Debug Adapter Protocol (DAP).
- Source control: Git CLI adapter with visible diffs and safe credential handling.
- Builds: language-specific adapters, toolchain detection, and explicit installation consent.
- Settings: human-readable JSON initially; add SQLite only if measured requirements justify it.
- Terminal: native process manager with visible command, working directory, exit code, cancellation, and environment disclosure.

## Architecture layers
1. Workbench UI: editor tabs, explorer, command palette, search, settings, diagnostics, output, keyboard navigation, accessibility.
2. Workspace services: safe file operations, project discovery, encoding/newlines, recent projects, autosave/recovery, conflict handling.
3. Editor services: syntax highlighting, formatting, completion, diagnostics, navigation, LSP lifecycle.
4. Execution services: terminal, task runner, build/run adapters, toolchain discovery, cancellation.
5. Debug services: DAP sessions, breakpoints, variables, stack frames, launch configurations.
6. SCM services: Git status/diff/stage/commit/branch operations with clear confirmation for destructive actions.
7. Extension host: manifest, publisher/license, version/API compatibility, permissions, install/uninstall, isolation.
8. Native platform: Tauri/Rust commands, dialogs, process spawning, OS integration, updates and packaging.
9. Trust/diagnostics: actionable errors, secret-redacted logs, crash recovery, support bundle export only after user review.

## Suggested repository layout
```text
src/                    React/TypeScript workbench
src-tauri/              Tauri app, Rust commands and capability policy
packages/core/           Shared types and service contracts
packages/editor/         Editor integration
packages/language/       LSP adapters
packages/debug/          DAP contracts and adapters
packages/scm/             Git integration
packages/toolchains/     Toolchain discovery/adapters
packages/extensions/     Extension manifest and host contracts
tests/unit/ integration/ e2e/
docs/                    Architecture, security, privacy, compatibility, release
```
This is a target layout, not a claim that all directories exist today. Build small vertical slices and split packages when implementation warrants it.

## Privacy and security
- Tauri capabilities must follow least privilege; do not expose unrestricted shell/filesystem/network access to the UI.
- Restrict file operations to user-selected workspaces; defend against traversal, symlink escape, and unsafe paths.
- Treat repositories, build scripts, terminal commands, and extensions as untrusted.
- No telemetry by default. Redact tokens, credentials, environment variables, and secrets from logs.
- External AI requires deliberate user action, provider selection, and clear disclosure of transmitted content.
- Audit and pin dependencies; never use forced upgrades as a routine vulnerability fix.
- Do not call code execution sandboxed unless a real sandbox is implemented and tested.

## Windows support policy
Prioritize supported Windows 11 and supported Windows 10 configurations. Windows 7, 8, and 8.1 are legacy targets and must not be promised until Tauri/runtime, TLS, signing, installation, update, and toolchain behavior are tested. Windows 9 was never released. Windows 10 standard support ended 14 October 2025; explain OS security status instead of weakening security for compatibility. Test x64/ARM64 only where real build infrastructure supports them.

## Reliability and UX
- Clear, actionable diagnostics and cancellation for long operations.
- Keyboard-first, beginner-friendly, accessible, high-DPI responsive layout.
- Autosave/recovery must preserve dirty buffers and never silently overwrite external changes.
- Offline operation for installed features and toolchains; show network requirements.
- Placeholder UI must never be described as a completed terminal, compiler, debugger, extension manager, or filesystem integration.

## Milestones
M0 repository hygiene, architecture and CI.
M1 persistent editor/workspace vertical slice.
M2 Tauri shell and real filesystem open/save.
M3 real terminal and task/toolchain adapters.
M4 Git integration and diagnostics.
M5 first LSP and run/debug adapter.
M6 secure extension model and optional AI.
M7 Windows packaging, signing, clean-machine testing, docs and store submission.

## Release gates
1. Reproducible dependency install and passing type-check/build.
2. Tests for file safety, persistence, settings, import/export.
3. Windows desktop build and native permission review.
4. Real file open/save, terminal, toolchain, Git and recovery tests.
5. Security/dependency review, clean install/upgrade/uninstall and data preservation.
6. Signed MSI/package, version, release notes, hashes, privacy/support docs and rollback plan.
7. Microsoft Partner Center submission; never claim approval until the actual certification decision.
