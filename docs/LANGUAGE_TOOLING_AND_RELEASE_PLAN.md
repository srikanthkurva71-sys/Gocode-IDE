# Language tooling, debugging, extensions, and release plan

This document defines the implementation and verification gates for the remaining IDE subsystems. It is a plan, not a claim that these features are already implemented.

## 1. Language Server Protocol (LSP)

### Required architecture
- Launch a user-installed language-server executable only after the user explicitly selects/configures it.
- Keep process launch configuration separate from project files; never execute a command from a repository-provided manifest automatically.
- Use the LSP stdio framing protocol (`Content-Length` headers), JSON-RPC request IDs, cancellation, and bounded message sizes.
- Initialize with negotiated capabilities, send `initialized`, and support document open/change/save/close notifications.
- Convert `textDocument/publishDiagnostics` into editor markers and the Problems panel; clear stale diagnostics when documents close or diagnostics are replaced.
- Stop child processes on shutdown and handle crashes, malformed frames, timeouts, and stderr without hanging the UI.
- Keep server output local. No project text is sent to a remote service by default.

### Initial scope
Start with one explicitly configured server (TypeScript/JavaScript is a practical first target), then add language-specific configuration for Python and Rust. Do not label Monaco syntax highlighting or Monaco validation as LSP support.

### Acceptance tests
- Unit tests for framing across partial reads, multiple messages in one read, malformed headers, oversized payloads, and JSON-RPC IDs.
- Integration test with a tiny local mock language server covering initialize, open, diagnostics, document changes, shutdown, and unexpected exit.
- UI test that a diagnostic is shown and clicking it moves the cursor to the reported line/column.
- Verify the server cannot start from untrusted project configuration without user approval.

## 2. Debug Adapter Protocol (DAP)

### Required architecture
- Launch only a user-configured debugger adapter after explicit user action.
- Implement DAP framing, request sequencing, initialization, launch/attach, configurationDone, stopped/continued/exited events, stackTrace, scopes, variables, breakpoints, and disconnect.
- Represent debugger states explicitly so buttons and UI cannot issue invalid commands during startup or shutdown.
- Bound message sizes and terminate adapter processes when sessions end or the IDE closes.

### Acceptance tests
- Protocol framing and request-response correlation unit tests.
- Mock-adapter integration tests for launch, breakpoint, stopped event, stack frame display, variable inspection, continue, and disconnect.
- At least one end-to-end debug session on a clean Windows runner and a manual test on a real supported Windows installation.

## 3. Extension execution host

The current extension registry is a manifest-review feature only. It must not be described as an installer or executable extension host.

Before executable extensions are enabled:
- Define a versioned API and a permission/capability model.
- Require explicit installation and permission approval, show publisher and license information, and support disable/uninstall.
- Run extensions in a restricted process with a narrow RPC API; do not treat JavaScript sandboxing alone as a security boundary.
- Restrict filesystem/network/process access by default and disclose every capability requested.
- Validate packages, reject path traversal and unsafe archive entries, and avoid automatic execution on project open.
- Provide crash isolation, logs, compatibility checks, and a way to revoke extension access.

### Acceptance tests
- Malformed-manifest and archive traversal tests.
- Permission-denial tests proving an extension cannot access ungranted APIs.
- Crash/restart tests and clean uninstall tests.
- Security review before enabling third-party executable code.

## 4. Windows runtime validation

CI's MSI build and install/launch/uninstall smoke test are useful but do not replace manual device testing. On a clean Windows 10/11 machine, verify:
- First launch, project open, file read/write, unsaved-change prompts, nested folders, and path edge cases.
- Terminal start/input/resize/close and child-process cleanup.
- Git status/diff/commit and confirmed pull/push using a test repository.
- Build-task confirmation, cancellation behavior, stdout/stderr limits, and process cleanup.
- MSI upgrade, repair, uninstall, user-data preservation, and reinstall.
- High-DPI scaling, keyboard shortcuts, window resizing, and application shutdown.
- No unexpected network requests or project uploads.

Compatibility with older Windows versions must remain unclaimed until built and tested on those versions.

## 5. Release readiness

- Run frontend tests/build, Rust tests, dependency audit, and Windows packaging on the exact release commit.
- Review dependency advisories and permissions/capabilities.
- Attach MSI and SHA-256 checksum to a draft release first.
- Test the signed/unsigned installation and update path as applicable.
- Complete privacy, license, attribution, security, compatibility, and recovery documentation.
- Keep `main` unchanged until the pull request has been reviewed and the user authorizes merging. Do not publish or submit to the Microsoft Store without explicit approval.

## Current status

As of the current development branch, frontend CI and the Windows MSI workflow pass, including Rust tests and the CI runner's install/launch/uninstall smoke test. LSP, DAP, and executable extension hosting remain unimplemented; manual testing on a real Windows device and release approval remain outstanding.
