# Gocode IDE — Architecture Decision Records

This file records decisions that should not be silently changed. New decisions must explain the problem, alternatives, migration impact, security impact, and verification plan.

## ADR-001: Windows desktop first

**Decision:** Build the first product as a Windows desktop application using Tauri 2.  
**Reason:** The product request prioritizes Windows applications and a native desktop IDE.  
**Consequences:** Windows-specific file paths, process behavior, packaging, signing, and clean-machine tests are release gates. Other OS targets remain uncommitted.

## ADR-002: React, TypeScript, Vite and Monaco

**Decision:** Keep the existing React/TypeScript/Vite workbench and Monaco editor.  
**Reason:** These are already implemented and provide a practical foundation for an extensible editor.  
**Consequences:** Avoid replacing the UI/editor stack without measured evidence. Keep editor-heavy state isolated to preserve responsiveness.

## ADR-003: Rust native service boundary

**Decision:** Use Rust/Tauri commands for privileged filesystem, process, PTY, Git, and protocol operations.  
**Reason:** The UI should not directly control arbitrary OS resources.  
**Consequences:** All security-sensitive validation must be repeated in Rust. Expose narrow typed commands only.

## ADR-004: Local-first and no mandatory account

**Decision:** No subscription, ads, mandatory account/OTP, or automatic project upload.  
**Reason:** These are core product commitments.  
**Consequences:** Core editing and local development must work offline. External providers are optional and disclose data transfer before confirmation.

## ADR-005: Protocol interoperability

**Decision:** Use LSP for language intelligence and DAP for debugging.  
**Reason:** Standard protocols reduce custom per-language integrations and vendor lock-in.  
**Consequences:** Support depends on separately installed compatible servers/adapters; protocol compliance and interoperability tests are required.

## ADR-006: Git CLI integration

**Decision:** Use the user's installed Git CLI and credential helper.  
**Reason:** This reuses standard Git configuration and avoids storing credentials in the IDE.  
**Consequences:** Show commands/targets for remote operations and require explicit confirmation for pull/push and destructive operations.

## ADR-007: No in-process executable extensions

**Decision:** Third-party executable extensions must not run in the React/WebView process.  
**Reason:** A WebView JavaScript sandbox is not a sufficient security boundary.  
**Consequences:** Executable extensions remain disabled until Windows process isolation, brokered APIs, explicit grants, resource limits, package validation, revocation, and review are implemented.

## ADR-008: Explicit project-code execution

**Decision:** Project scripts, tasks, builds, and custom commands never run automatically when a workspace opens.  
**Reason:** A repository is untrusted input and may contain malicious commands.  
**Consequences:** Show the command and working directory and request user confirmation before first or changed execution.

## ADR-009: Versioned local settings

**Decision:** Start with schema-validated local JSON settings and recovery metadata.  
**Reason:** This is adequate for current scale and is inspectable/portable.  
**Consequences:** Add migrations and atomic writes. Introduce a database only when measured concurrency/query requirements justify it.

## ADR-010: Incremental architecture evolution

**Decision:** Keep the current repository layout and extract modules only around stable, tested boundaries.  
**Reason:** Premature package splitting increases integration overhead and risks regressions.  
**Consequences:** Implement vertical slices; avoid broad rewrites of working code.

## ADR-011: Truthful support claims

**Decision:** Distinguish implemented, experimental, planned, and unsupported features in documentation and UI.  
**Reason:** A protocol scaffold or placeholder is not a production-ready debugger, extension host, or language server.  
**Consequences:** Every release feature claim must be tied to acceptance tests and supported platforms.
