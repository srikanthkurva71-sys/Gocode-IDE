# Native Boundary and Process Inventory

**Reviewed against:** `work/gpt-extension-permissions` at `3d336262f80d0bfc65862ef84f7ed5f8b874bd9b`  
**Purpose:** Establish the Stage 1 baseline before changing native command contracts or splitting the Tauri command module.  
**Status:** Source inventory only; this is not a security audit or proof of runtime isolation.

## 1. Runtime trust zones

| Zone | Current implementation | Boundary that must remain enforced |
|---|---|---|
| Workbench | `src/App.tsx` (React, Monaco, xterm.js) | UI state and rendering only; privileged operations go through narrow Tauri commands or explicitly scoped plugins. |
| Native command layer | `src-tauri/src/lib.rs`, `lsp.rs`, `dap.rs`, and focused Rust modules | Validate all arguments again in Rust; bound input/output; return actionable errors; do not trust UI validation. |
| Child processes | task runner, terminal, LSP, DAP, Git and toolchain commands | Explicit user action/confirmation, argument arrays, bounded output/time, cancellation and process-tree cleanup. |
| Future extension workers | Not implemented | Must be isolated out of process and use a default-deny, permission-checked broker. No executable extension support is available. |

## 2. Registered native command surface

The command handler in `src-tauri/src/lib.rs` registers the following application commands:

- **Workspace:** `set_project_root`, `get_project_root`, `list_project_files`, `search_project_files`, `cancel_project_search`, `read_project_file`, `write_project_file`, `create_project_directory`.
- **Git:** `git_status`, `git_history`, `git_show_commit`, `git_diff`, `git_apply_hunk`, `git_stage_all`, `git_commit`, `git_list_branches`, `git_checkout_branch`, `git_pull_ff_only`, `git_push_current_branch`.
- **Build and run:** `detect_project_tasks`, `run_source_file`, `start_project_task`, `start_source_file_task`, `cancel_project_task`.
- **Terminal:** `start_terminal`, `write_terminal_input`, `resize_terminal`, `close_terminal`.
- **Extension package inspection:** `inspect_extension_package`.
- **Language and debugging protocols:** `lsp::lsp_start`, `lsp::lsp_send`, `lsp::lsp_stop`, `dap::dap_start`, `dap::dap_send`, `dap::dap_stop`.

The current Rust command surface primarily returns `Result<T, String>`. This preserves simple UI error display but does not provide stable machine-readable error categories. Stage 1 should introduce typed internal errors and stable codes incrementally, without changing existing frontend contracts in one broad migration.

## 3. Process launch and lifecycle inventory

| Process class | Launch/control location | Required invariants |
|---|---|---|
| Project tasks and Run File | `src-tauri/src/task_runner.rs`, called by `lib.rs` | Fixed adapter resolution; no shell interpolation for detected tasks; bounded output; wall-clock timeout; cancellation; process-tree termination. |
| Integrated terminal | `lib.rs` using `portable-pty` | Explicit user start; bounded session state; input/resize/close lifecycle; child cleanup at application shutdown. |
| LSP | `src-tauri/src/lsp.rs` and `lsp_protocol.rs` | User-configured executable/arguments; framed JSON-RPC; bounded messages and requests; URI/workspace validation; cancellation/restart/recovery; terminate on protocol/process failure. |
| DAP | `src-tauri/src/dap.rs` | User-configured adapter; framed protocol; bounded requests; lifecycle state machine; cancellation/termination; clear stale inspection state. |
| Git | `lib.rs` Git command helpers | Use installed Git CLI and configured credential helper; argument arrays; explicit confirmation for remote/destructive operations; no credentials in IDE logs/settings. |
| Extension worker | Not implemented | No third-party code may execute until Windows isolation, inherited-handle/environment controls, resource limits, broker authorization and revocation are implemented and reviewed. |

## 4. Tauri capability and frontend invoke inventory

The default window capability is `src-tauri/capabilities/default.json`. It currently grants:

- `core:default`
- `dialog:allow-open` and `dialog:allow-save`
- `fs:allow-read-text-file` and `fs:allow-write-text-file`
- `core:event:default`

The frontend imports Tauri `invoke`, event `listen`, dialog `open/save`, and filesystem `readTextFile/writeTextFile` APIs. This means the review must cover both custom Rust commands and plugin permissions; reviewing only the `invoke_handler` would miss part of the privileged surface.

Before changing plugin scopes, enumerate every frontend call site and test the actual packaged-app behavior. Do not remove permissions or tighten scopes speculatively in a way that breaks project file access.

## 5. Existing focused modules

- `task_runner.rs`: fixed task resolution, bounded streaming process output, timeout/cancellation and platform process ownership.
- `workspace_io.rs`: UTF-8/BOM/newline preservation, external-change checks and atomic writes.
- `git_hunks.rs`: patch/hunk policy helpers.
- `lsp_protocol.rs`: bounded LSP framing.
- `lsp.rs` and `dap.rs`: protocol process/session management.
- `extension_archive_policy.rs` and `extension_archive.rs`: archive inventory validation and bounded package inspection.
- `extension_policy.rs`: pure default-deny capability vocabulary and decision evaluation; not yet connected to an executable worker or broker.

## 6. Gaps to address in Stage 1

1. `lib.rs` remains a large mixed command/state/test module. Extract cohesive modules only where ownership and test boundaries are clear; preserve command names and behavior.
2. Native commands mostly expose string errors. Add typed internal error categories first, then adapt at command boundaries so the current UI remains compatible.
3. Document request/result contracts for workspace, process/task, Git, LSP and DAP commands, including size limits, cancellation semantics and resource ownership.
4. Review the effective filesystem plugin scope against the native workspace boundary. The capability declaration alone is not evidence of the effective runtime scope.
5. Build an automated inventory or regression test ensuring every registered command has an owner and every process launch path has timeout/cleanup coverage.
6. Keep extension execution disabled. Package inspection and permission-policy unit tests are not an extension host.

## 7. Evidence and limitations

This inventory was derived from the checked-in source files and workflow definitions. It does not establish that all commands have been manually exercised on a physical Windows device. The latest branch-head frontend workflow passed on the documentation-only head commit; Rust native tests and the Windows MSI workflow passed on its immediately preceding code commit. Re-run all relevant workflows after source changes and keep the MSI as a CI artifact until release approval.

## Source map

- `src-tauri/src/lib.rs`
- `src-tauri/src/task_runner.rs`
- `src-tauri/src/workspace_io.rs`
- `src-tauri/src/lsp.rs`
- `src-tauri/src/lsp_protocol.rs`
- `src-tauri/src/dap.rs`
- `src-tauri/src/extension_policy.rs`
- `src-tauri/capabilities/default.json`
- `src/App.tsx`
- `.github/workflows/frontend-build.yml`
- `.github/workflows/rust-tests.yml`
- `.github/workflows/windows-msi.yml`
