# Gocode IDE — Implementation Plan

This plan follows the current repository and the Product Architecture. Work is delivered as small, testable vertical slices. Do not merge to `main` or publish releases without user approval.

## Stage 0 — Architecture and baseline (current)
- [x] Confirm repository identity and existing development branch.
- [x] Record product commitments: free, local-first, no mandatory account, no automatic uploads.
- [x] Document Windows/Tauri/React/Monaco/Rust architecture and trust boundaries.
- [x] Document architecture decisions and current limitations.
- [ ] Verify all current CI workflows on the architecture commit.

## Stage 1 — Native service modularity and contracts
- [ ] Split the oversized Tauri command module into cohesive modules without behavior changes.
- [x] Extract fixed project-task resolution, result contracts, and bounded output formatting into a tested native module.
- [ ] Introduce typed request/result/error structures for workspace, process, task, Git, LSP and DAP operations.
- [ ] Add stable error categories while preserving actionable messages.
- [x] Add unit tests for atomic workspace writes and streaming bounded process-output capture.
- [x] Add a Unix regression test proving completed tasks do not hang when descendants retain inherited output pipes; Windows process-tree lifecycle still needs Job Object coverage.
- Native LSP/DAP readers now terminate their child process when the protocol output stream closes unexpectedly, allowing the monitor to reap the session instead of leaving a background process running.
- Acceptance: frontend and Rust tests pass; no user-visible regression.

## Stage 2 — Workspace and editor correctness
- [ ] Consolidate native project buffers and browser-local buffers behind explicit storage adapters.
- [x] Add external-file-change detection using saved disk baselines; reject stale saves instead of silently overwriting external edits.
- [x] Add atomic writes for native project saves.
- [x] Preserve UTF-8 BOM and dominant LF/CRLF/CR newline style across native editor round-trips; reject invalid UTF-8 instead of silently corrupting bytes.
- [x] Add bounded local project-buffer crash recovery snapshots and explicit restore confirmation; verify disk baselines and restore into the editor without writing to disk.
- [x] Add a fixed-row virtualized project tree with bounded DOM rendering and collapsed-directory filtering.
- [x] Add cancellable native project search with generation-based cancellation checks during directory traversal and line scanning, a native cancel command, and stale-result protection in the UI.
- Acceptance: tests cover dirty buffers, external modification, crash recovery, Unicode paths, traversal and symlink escape.

## Stage 3 — Workbench usability and performance
- [ ] Add split editor groups and drag/drop tab movement.
- [ ] Add breadcrumbs, outline, go-to-symbol, and recent-file history.
- [ ] Add keyboard shortcut customization and command discoverability.
- [ ] Add performance instrumentation/benchmarks for startup, large file open, typing, project listing and search.
- [ ] Fix measured bottlenecks; do not optimize from assumptions.
- Acceptance: benchmark baselines documented; UI remains responsive on representative large workspaces.

## Stage 4 — Build, run and task platform
- [x] Apply the shared bounded process runner to project tasks and Run File for Python, JavaScript, Go, Rust, C and C++.
- [x] Detect installed toolchains on PATH and offer only supported fixed adapters for detected project manifests (Node, Python, Go, Rust, CMake, Make, Maven, Gradle, and .NET).
- [ ] Consolidate toolchain discovery and task adapter contracts into reusable profiles.
- [ ] Add task profiles for common project types (Node, Python, Go, Rust, C/C++, Java, .NET) based on installed toolchains.
- [ ] Add task configuration with explicit trust/confirmation and argument-array execution.
- [x] Add bounded streaming stdout/stderr capture for project tasks.
- [x] Add wall-clock timeouts, bounded streaming output and process-tree termination on Windows; Unix tasks run in isolated process groups and terminate the group on timeout.
- [x] Add user-triggered cancellation for detected project tasks and Run Current File, live stdout/stderr events, and task lifecycle progress events.
- [x] Add Windows Job Object ownership with kill-on-close and explicit job termination after parent exit, timeout, or user cancellation; add Windows descendant-process and cancellation regression tests.
- [ ] Add test runner integration and test result navigation.
- Acceptance: mock process tests plus real Windows smoke tests for available toolchains.

## Stage 5 — Language intelligence and debugger
- [x] Add bounded LSP request timeouts and clear pending requests on response, send failure, stop and server exit.
- [x] Restrict incoming LSP diagnostics to normalized file URIs strictly beneath the active workspace root; reject encoded traversal, backslash separators, non-file schemes and foreign file hosts.
- [x] Send JSON-RPC cancellation notifications for timed-out and superseded hover/completion requests.
- [x] Add explicit language-server restart using the last trusted executable and argument list, reset pending requests/diagnostics/doc state, and reinitialize the active document after restart or unexpected exit.
- [x] Add automatic LSP recovery for unexpected process exits and initialization failures, with at most three retries using bounded exponential backoff (1s, 2s, 4s); manual start/stop/restart cancels pending recovery, and switching workspaces stops the previous session.
- [x] Persist explicitly named trusted language-server launch profiles locally across application restarts, with bounded validation, absolute executable paths, case-insensitive upsert, malformed-entry recovery, and rejection of secret-like arguments from persistence.
- [x] Add a mock language-server process integration test covering initialize/capabilities, initialized, completion, diagnostics, shutdown and exit over real stdin/stdout pipes.
- [x] Add CI smoke test that installs real Rust Analyzer and validates initialize/shutdown over LSP stdio on Linux and Windows.
- [x] Add debugger stepping controls (continue, step over, step into, step out and pause) alongside existing thread, stack-frame, scope and variable views.
- [x] Handle core DAP stopped/continued/thread/output/breakpoint/terminated/exited events, request failures, and clear stale inspection state when sessions end.
- [x] Add bounded DAP request timeouts and clear pending requests on response, send failure, stop and adapter exit.
- [x] Add DAP watch-expression evaluation UI using adapter-supported `evaluate` requests.
- [x] Send a best-effort DAP `cancel` request when an outstanding adapter request reaches its UI timeout.
- [x] Add validated launch/attach profiles with bounded JSON configuration, case-insensitive profile replacement, and session-only storage to avoid persisting possible adapter secrets.
- [ ] Complete the DAP state machine and reusable persistent launch configurations.
- [x] Add a mock debug-adapter process integration test covering initialize, initialized event, launch, threads, response correlation and disconnect over real stdin/stdout pipes.
- [x] Add CI smoke test that installs pinned debugpy and validates real DAP initialize, launch/configuration, stopped, threads, stackTrace, scopes, continue/terminated, and disconnect on Linux and Windows.
- Acceptance: documented tested server/adapter combinations; no claims beyond those combinations.

## Stage 6 — Git and collaboration workflow
- [x] Add hunk-level staging, unstage and discard with confirmation; validate patch bounds and test native Git stage/unstage/discard behavior.
- [ ] Add commit history and diff navigation.
- [ ] Improve branch switching safeguards and conflict reporting.
- [ ] Test pull/push with a local remote and configured credential helper.
- Acceptance: destructive actions are explicit and tested; credentials never enter IDE logs/settings.

## Stage 7 — Secure extension platform
- [ ] Finalize manifest schema and API compatibility policy.
- [ ] Implement package validation and safe archive extraction.
- [ ] Implement Windows-enforced worker isolation and brokered RPC.
- [ ] Connect native permission policy to every broker method.
- [ ] Implement explicit install/enable/disable/revoke/update/uninstall lifecycle.
- [ ] Security review and adversarial tests before enabling third-party execution.
- Acceptance: ungranted APIs are unreachable, workers cannot escape allowed resources, and revocation is enforced.

## Stage 8 — Release hardening
- [ ] Complete Windows x64 compatibility matrix; separately validate ARM64 if supported.
- [ ] Test clean install, upgrade, repair, uninstall, reinstall and data preservation.
- [ ] Add signing and publisher identity validation before public distribution.
- [ ] Complete privacy, security, licenses, attribution, support and release notes.
- [ ] Create draft release with verified MSI and SHA-256; obtain user approval before publishing.
- Acceptance: all release gates in `docs/PRODUCT_ARCHITECTURE.md` pass.

## Current implementation classification

**Implemented in the current development branch:** workbench/editor, tabs, project explorer, bounded file operations, local Git basics, terminal/PTY, toolchain-aware task discovery for Node, Python, Go, Rust, CMake, Make, Maven, Gradle and .NET, selected task adapters, bounded Run File, asynchronous project tasks and Run Current File with user cancellation, streamed task output and lifecycle progress events, process-tree termination and timeouts, LSP/DAP prototypes, bounded LSP/DAP request timeouts, LSP JSON-RPC cancellation for expired/superseded interactive requests, manual LSP restart/recovery with duplicate-initialize protection, bounded automatic LSP crash and initialization-failure recovery, workspace-switch LSP shutdown, normalized project-local LSP diagnostic URI filtering, bounded local project-buffer crash recovery with explicit restore confirmation and disk-baseline checks, UTF-8 BOM/newline-style preservation for native text files, hunk-level Git stage/unstage/discard with confirmation, LSP/DAP child-process monitoring and shutdown cleanup, protocol-reader failure termination, DAP stepping controls, watch-expression evaluation UI, core DAP event lifecycle handling, best-effort DAP cancellation after request timeouts, validated session-only DAP launch/attach profiles, manifest review, CI MSI packaging.

**Experimental / incomplete:** broader real debugger compatibility beyond the tested debugpy DAP flow and broader real-server compatibility beyond the Rust Analyzer initialize/shutdown smoke test; broader language-server compatibility and persistent profile migration/recovery testing; mock LSP/DAP process exchanges are covered by native integration tests, real debugpy DAP launch/inspection/shutdown is smoke-tested on Linux and Windows, explicitly named LSP launch profiles are persisted locally with secret-like argument rejection, debugger completeness, DAP cancellation depends on adapter support and is best-effort, launch profiles currently reset when the app closes, Windows Job Object assignment occurs immediately after process creation (a very small pre-assignment child-spawn race remains), recovery restore still needs a packaged-app restart smoke test; snapshots are limited to 25 open dirty native project files and 5 MiB, stored locally, and only one pending project snapshot is retained; mixed-newline files use their dominant newline convention; task cancellation covers detected project tasks and Run Current File but not interactive terminal sessions, progress is lifecycle/output based rather than a percentage estimate, real Windows-device validation.

**Not implemented:** production extension execution host, marketplace, true OS sandboxing, complete test explorer, split editor groups, full workspace indexing, production updater, code signing, store certification.

This classification must be updated only when code and tests demonstrate the change.


## Stage 9 — Website, feedback and distribution
- [x] Define GitHub Pages website source and deployment workflow (deployment awaits Pages configuration and default-branch merge).
- [x] Add privacy-preserving, user-reviewed GitHub feedback issue link and validation tests.
- [ ] Verify external-browser opening from a packaged Windows build.
- [ ] Enable GitHub Pages in repository settings and verify the deployed URL.
- [ ] Build a Store-compatible MSIX with stable package identity and validate publisher signing.
- [ ] Prepare Partner Center listing assets, privacy/support URLs, declarations and release notes.
- [ ] Submit for Microsoft Store certification only after clean-device validation and explicit approval.
- Acceptance: feedback is reviewable before submission; Pages is live; Store package passes identity/signing and certification checks.
