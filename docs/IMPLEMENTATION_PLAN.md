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
- [x] Add unit tests for atomic workspace writes and streaming bounded process-output capture.\n- [ ] Add broader integration tests around native workspace operations and process-tree cleanup.
- Acceptance: frontend and Rust tests pass; no user-visible regression.

## Stage 2 — Workspace and editor correctness
- [ ] Consolidate native project buffers and browser-local buffers behind explicit storage adapters.
- [ ] Add external-file-change detection and conflict-safe save.
- [x] Add atomic writes for native project saves.\n- [ ] Preserve original encoding and line-ending style during editor round-trips.
- [ ] Add bounded local crash recovery and recovery UI.
- [ ] Add lazy/virtualized project tree and cancellable search.
- Acceptance: tests cover dirty buffers, external modification, crash recovery, Unicode paths, traversal and symlink escape.

## Stage 3 — Workbench usability and performance
- [ ] Add split editor groups and drag/drop tab movement.
- [ ] Add breadcrumbs, outline, go-to-symbol, and recent-file history.
- [ ] Add keyboard shortcut customization and command discoverability.
- [ ] Add performance instrumentation/benchmarks for startup, large file open, typing, project listing and search.
- [ ] Fix measured bottlenecks; do not optimize from assumptions.
- Acceptance: benchmark baselines documented; UI remains responsive on representative large workspaces.

## Stage 4 — Build, run and task platform
- [ ] Consolidate toolchain discovery and task adapter contracts.
- [ ] Add task profiles for common project types (Node, Python, Go, Rust, C/C++, Java, .NET) based on installed toolchains.
- [ ] Add task configuration with explicit trust/confirmation and argument-array execution.
- [x] Add bounded streaming stdout/stderr capture for project tasks.\n- [ ] Add cancellation, timeouts and Windows child-process tree cleanup.
- [ ] Add test runner integration and test result navigation.
- Acceptance: mock process tests plus real Windows smoke tests for available toolchains.

## Stage 5 — Language intelligence and debugger
- [ ] Complete LSP request correlation, cancellation, timeout and session restart.
- [ ] Add mock language-server integration tests and test at least one real server on Windows.
- [ ] Complete DAP state machine, configurationDone, stopped/continued/exited handling, variable/watch UI and launch configurations.
- [ ] Add mock adapter integration tests and test at least one real debugger adapter on Windows.
- Acceptance: documented tested server/adapter combinations; no claims beyond those combinations.

## Stage 6 — Git and collaboration workflow
- [ ] Add hunk-level staging, unstage and discard with confirmation.
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

**Implemented in the current development branch:** workbench/editor, tabs, project explorer, bounded file operations, local Git basics, terminal/PTY, selected task adapters, LSP/DAP prototypes, manifest review, CI MSI packaging.

**Experimental / incomplete:** LSP/DAP lifecycle and adapter interoperability, debugger completeness, process cleanup edge cases, native project buffer recovery/conflict handling, full task system, real Windows-device validation.

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
