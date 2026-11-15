# Gocode IDE — Product and Technical Architecture

**Document status:** Architecture baseline for implementation  
**Product:** Gocode IDE for Windows desktop  
**Repository:** `srikanthkurva71-sys/Gocode-IDE`  
**Architecture rule:** Preserve working implementations and evolve through tested vertical slices. This document defines target behavior; it does not imply every subsystem is complete.

## 1. Product definition

Gocode IDE is a free, local-first, extensible Windows desktop integrated development environment for creating, editing, building, testing, debugging, and maintaining software projects.

It aims to provide a coherent workbench comparable in capability to established desktop IDEs while remaining:
- Free to use: no subscription, advertising, paid feature tiers, or mandatory account.
- Local-first: project files remain on the user's machine unless the user explicitly initiates an external operation.
- Offline-capable: editing and local project operations do not require cloud sign-in.
- Extensible: third-party functionality is introduced through a versioned API and explicit permission grants, not unrestricted in-process code.
- Open and interoperable: prefer documented protocols and common project formats rather than proprietary lock-in.
- Windows-focused: Windows 11 and supported Windows 10 are the initial desktop targets. Other platforms are not promised until separately tested.

The IDE itself does not charge users. Optional external providers may impose their own terms or charges; those must be disclosed before use.

## 2. Product scope

### Core workbench
- Multi-root-capable workspace model (initial release may expose one active project root).
- File explorer, tabs, split-editor target, breadcrumbs, outline, quick open, command palette, global search.
- Monaco editor with configurable typography, themes, minimap, wrapping, keyboard shortcuts, and accessible navigation.
- Dirty-buffer tracking, explicit save/save-all, external-change detection, recovery, and conflict-safe writes.
- Problems, output, terminal, debug console, and task panels.

### Build and run
- Toolchain discovery without automatic installation.
- Explicitly configured runtime/compiler paths and project task adapters.
- Safe fixed adapters for supported build systems, plus user-confirmed custom tasks.
- Visible command, working directory, environment policy, output, exit code, cancellation, and process lifecycle.
- Per-language run configurations and build/test tasks.

### Language intelligence
- Syntax highlighting independent of language-server availability.
- LSP for diagnostics, completion, hover, definition, references, rename, formatting, symbols, and code actions where the server supports them.
- Language-specific server configuration, capability negotiation, timeouts, cancellation, crash recovery, and workspace scoping.

### Debugging
- DAP adapter integration with explicit launch/attach configurations.
- Breakpoints, stepping, continue/pause, call stack, scopes, variables, watches, exception events, and debug console.
- Explicit debugger state machine and process lifecycle.

### Source control
- Git status, branch, diff, stage/unstage, commit, discard, stash, and history.
- Pull/push only after explicit confirmation; show remote, branch, and operation before execution.
- Use the installed Git CLI; do not embed credentials in settings or logs.

### Extensions
- Manifest inspection and compatibility validation.
- Package provenance, publisher identity verification where possible, license, version, API compatibility, and permission review.
- Isolated extension worker and brokered APIs only after Windows isolation is implemented and reviewed.
- Install disabled by default; explicit enable, disable, revoke, update, and uninstall.
- No extension execution in the workbench WebView.

### Optional integrations
- AI and cloud providers are optional and disabled until configured by the user.
- Before sending content externally, identify provider, exact content categories, purpose, and provider terms; require confirmation.
- No automatic project indexing upload, telemetry, account creation, or remote project backup.

## 3. Supported technology decisions

| Layer | Decision | Rationale / constraint |
|---|---|---|
| Desktop shell | Tauri 2 | Native Windows integration with a Rust backend and a web UI |
| Native services | Rust | File/process boundaries, PTY, Git, LSP/DAP process management |
| Workbench UI | React + TypeScript + Vite | Existing implementation; typed UI and rapid iteration |
| Editor | Monaco Editor | Already integrated; VS Code-like editing and language support |
| Terminal | `portable-pty` + xterm.js | Native PTY with terminal rendering |
| Serialization | Serde + JSON | Typed native commands and protocol payloads |
| Language protocol | LSP over stdio JSON-RPC | Interoperable language intelligence |
| Debug protocol | DAP over stdio | Interoperable debugger adapters |
| Version control | Git CLI | Reuses installed Git and established credential helpers |
| Settings | Versioned local JSON initially | Simple, inspectable, portable; migrate only if measured needs justify a database |
| Tests | Vitest + Rust tests + Windows CI | Fast unit feedback plus platform-specific packaging checks |
| Installer | Tauri MSI | Current Windows packaging target |

Do not add dependencies or split the application into many packages merely for architectural appearance. Extract modules when a stable interface and independent test boundary exist.

## 4. Runtime architecture

The application is divided into four trust zones.

### A. Workbench process (React/WebView)
Owns presentation and interaction: editor view state, tabs, panel state, command palette, forms, and rendering. It may call only explicit, typed native commands and subscribe to documented events. It must not receive arbitrary filesystem or process handles.

### B. Native application service layer (Rust/Tauri)
Owns authoritative access to selected workspace files, process creation, PTY sessions, Git operations, task execution, LSP/DAP sessions, settings persistence, and OS dialogs. Every command validates input, bounds resource use, returns structured errors, and checks workspace boundaries.

### C. Child tool processes
Compilers, interpreters, Git, language servers, debug adapters, and terminals are separate OS processes. They are launched only through explicit user actions or an approved task. Their executable, arguments, working directory, environment, stdin/stdout/stderr, exit status, cancellation, and cleanup are managed and observable.

### D. Future extension workers
Third-party extensions must run out-of-process under Windows-enforced restrictions. They communicate through a versioned, bounded RPC broker. The extension worker never receives raw Tauri access, unrestricted workspace paths, inherited secrets, or arbitrary process/network access.

### Command flow
1. UI validates form-level constraints for good feedback.
2. UI invokes a named native command with a typed payload.
3. Rust repeats all security-sensitive validation; frontend checks are never trusted as enforcement.
4. Native service authorizes workspace scope and permission.
5. Operation executes with timeouts, cancellation, and output limits where applicable.
6. Native service returns a typed result and emits lifecycle events.
7. UI renders success/error without assuming that an invocation succeeded.

## 5. Repository architecture

Current implementation should remain in the established structure until module boundaries are extracted safely:

```text
src/
  App.tsx                 Workbench composition and current feature wiring
  main.tsx                UI entry point
  styles.css              Workbench styling
  lib/
    workspace.ts          Browser workspace validation, import/export, search helpers
    commandLine.ts        Command-line parsing helpers
    languageProtocol.ts   LSP result normalization and UI contracts
    languageFeatures.ts   Hover/completion/navigation normalization
    debugProtocol.ts      DAP result normalization
    extensionManifest.ts  Manifest validation (review only)
    capabilityReview.ts   Advisory capability risk labels
    *.test.ts             Unit tests

src-tauri/
  src/
    lib.rs                Tauri command registration and native project/process services
    lsp.rs                Native LSP child process sessions
    lsp_protocol.rs       LSP framing/protocol helpers
    dap.rs                Native DAP child process sessions
    extension_policy.rs   Default-deny extension permission policy (not a host)
    task_runner.rs        Fixed project-task registry and bounded output contract
  capabilities/
    default.json          Tauri WebView capability grants
  tauri.conf.json         Desktop window, CSP, bundle configuration

docs/
  ARCHITECTURE.md
  PRODUCT_ARCHITECTURE.md
  ARCHITECTURE_DECISIONS.md
  IMPLEMENTATION_PLAN.md
  SECURITY.md
  PRIVACY.md
  COMPATIBILITY.md
  EXTENSION_HOST_DESIGN.md
  LANGUAGE_TOOLING_AND_RELEASE_PLAN.md
  RELEASE.md

.github/workflows/
  frontend-build.yml
  windows-msi.yml
```

As the codebase grows, extract cohesive modules such as `workspace_service`, `process_manager`, `task_runner`, `git_service`, `settings_service`, and protocol session managers. Each extraction must preserve behavior and add tests. Avoid a premature multi-crate or multi-package rewrite.

## 6. Core domain contracts

### Workspace
A workspace is a user-selected canonical directory plus a stable workspace identity. All native file operations resolve paths relative to that root. The native layer rejects absolute paths, parent traversal, Windows device names, invalid separators, symlink escapes, and unsupported file types. Recursive enumeration is bounded by entry count, depth, file size, and time.

Workspace metadata is separate from project content. Remembering a recent path must not copy project files elsewhere. Do not follow symlinks by default. Any future symlink support must resolve and verify the final canonical target remains inside the allowed root.

### Document and editor buffer
A document has a URI/path, language identifier, encoding, line-ending convention, current buffer version, saved version, dirty flag, and diagnostics. Editor state is not the source of truth for disk state. Saving must:
- detect external modifications since last read;
- avoid overwriting a newer disk version without user resolution;
- write atomically where feasible;
- preserve encoding and line endings;
- update dirty state only after a successful native write.

Recovery data is local and bounded. It must be possible to recover dirty buffers after a crash without silently replacing the original file.

### Task and process
A task definition has an ID, label, adapter type, executable, argument vector, working directory, environment policy, input/output limits, timeout, and confirmation policy. Never build a shell command by concatenating untrusted values. Prefer executable plus argument arrays. Custom shell tasks are explicitly marked as arbitrary code execution and require user confirmation.

A process session has a unique ID, state (starting/running/cancelling/exited/failed), start time, exit code, bounded output, and cancellation method. All managed child processes must be terminated and waited on during shutdown.

### Diagnostic
A diagnostic includes source, code, severity, message, URI, start/end line and column, and optional related information. Invalid ranges and oversized messages are rejected or normalized before rendering.

### Extension
An extension has immutable ID, version, publisher metadata, package digest, license, API version range, requested permissions, install state, enable state, and grant record. Manifest claims are untrusted until verified. Risk labels are advisory, not access control.

## 7. Native command and event API

Native commands are explicit, narrow, typed, and versioned by behavior. The UI must not receive generic "run arbitrary command" or "read arbitrary path" powers.

Command groups:
- `workspace.*`: choose/open root, list entries, read/write file, create directory, search files, reveal path.
- `editor.*`: save operations and editor-related native metadata where necessary.
- `terminal.*`: start PTY, write input, resize, close, report exit.
- `task.*`: discover known tasks, run approved task, cancel task, retrieve bounded output.
- `git.*`: status, diff, branches, stage, unstage, commit, checkout, pull, push.
- `lsp.*`: start, initialize, send request/notification, stop, inspect status.
- `dap.*`: start, send request, stop, inspect status.
- `settings.*`: read, validate, update, migrate local settings.
- `system.*`: app version, platform capability, diagnostics export after review.

Event groups:
- `terminal-output`, `terminal-exited`
- `task-output`, `task-state`
- `lsp-message`, `lsp-error`, `lsp-exited`
- `dap-message`, `dap-error`, `dap-exited`
- `workspace-changed` for external file watcher events

Every event is scoped to a session/workspace ID. Events must be bounded and listeners removed on component teardown. A dropped UI listener must not leak a native child process.

## 8. Performance architecture

Performance targets are engineering budgets to measure, not guarantees:
- Warm launch: target under 3 seconds on a representative supported Windows machine.
- UI input: keep common interactions responsive; avoid synchronous filesystem or process work on the UI thread.
- Large workspace: incremental/lazy tree loading, bounded search, ignore generated folders, debounce queries, and cancel stale work.
- Editor: avoid rerendering the full workbench on every keystroke; isolate editor state and memoize expensive panel computations.
- Output: stream in chunks with bounded ring buffers and truncation markers; never retain unlimited terminal/task output.
- LSP/DAP: asynchronous request correlation, per-request timeouts, cancellation, and bounded pending request counts.
- Memory: cap caches, workspace indexes, diagnostics, and session history; release them on project close.
- Startup: defer nonessential indexing and toolchain discovery until after first paint or user request.

Before optimizing, add reproducible benchmarks for startup, large file open, workspace enumeration/search, editor typing, and terminal output throughput.

## 9. Reliability and recovery

- Every long-running operation has a visible state, cancellation path, timeout policy, and bounded output.
- Native command errors use stable error categories and actionable user messages; raw internal details go to local redacted logs.
- Unexpected child-process exit updates UI state and allows restart without restarting the IDE.
- Shutdown closes sessions, terminates and waits for children, flushes settings, and persists recovery metadata.
- Atomic settings writes and schema migrations include backup/rollback.
- External file changes trigger a conflict-aware reload/compare flow.
- Corrupt settings fall back safely while preserving a backup for recovery.

## 10. Security architecture

- Tauri capability configuration remains least-privilege; review every plugin permission added.
- Content Security Policy remains restrictive. Do not enable remote script sources.
- Native commands independently validate every argument and enforce canonical workspace boundaries.
- Build/test/run commands and project configuration are untrusted code. No automatic execution on project open.
- Toolchain discovery may inspect known executable metadata but must not run project-controlled scripts.
- Secrets are not stored in plain settings or written to logs. Use Windows Credential Manager/DPAPI only when a real credential feature is added.
- Git credentials are delegated to the user's configured Git credential helper.
- No telemetry by default. Any future opt-in telemetry must be privacy-reviewed and avoid project paths/content.
- Extensions are disabled until process isolation, permission enforcement, package validation, revocation, resource controls, and security review are complete.
- AI/cloud integrations require explicit provider selection and a per-operation data disclosure/confirmation.

## 11. Settings and configuration

Settings are local, versioned, schema-validated, and split into:
- User settings: editor preferences, theme, keyboard shortcuts, tool paths, UI layout.
- Workspace settings: project-specific editor behavior and task definitions; untrusted execution fields require confirmation.
- Runtime state: recent files, panel state, recovery snapshots, recent workspace paths.

Do not persist access tokens, passwords, raw secrets, or full environment dumps. Workspace settings are untrusted repository content; opening a project must not auto-run tasks, extensions, or tool commands from them.

## 12. Windows packaging and compatibility

Initial target: supported Windows 11 and supported Windows 10 x64. ARM64 is a separate target only after a real build/test matrix exists. Do not promise Windows 7/8/8.1. Windows 10 standard support ended 14 October 2025; communicate its security status and do not weaken cryptographic or runtime requirements to prolong compatibility.

Installer requirements:
- MSI install, upgrade, repair, uninstall, and reinstall validation.
- Preserve user settings and recovery data across normal upgrades; uninstall behavior must be explicit.
- Generate SHA-256 hashes and attach release notes.
- Code signing and publisher identity must be verified before public distribution.
- Test on clean Windows VMs and a real supported device.
- Do not claim Microsoft Store approval until certification is received.

## 13. Testing strategy

### Unit tests
Pure TypeScript/Rust validation: paths, manifests, settings migration, protocol framing, JSON-RPC/DAP normalization, output truncation, command argument construction, and state transitions.

### Native integration tests
Temporary workspaces and mock child processes: file read/write, symlink traversal rejection, cancellation, timeout, process cleanup, LSP/DAP request lifecycle, Git operations against local temporary repositories.

### UI tests
Keyboard navigation, tabs, dirty-state prompts, command palette, diagnostics navigation, panel state, accessibility labels, and error handling.

### Windows end-to-end
Clean-machine install/launch/uninstall, open/save nested files, Unicode paths, terminal, build task, Git, LSP/DAP mock adapters, crash recovery, high-DPI, upgrade preservation, and offline operation.

### Security tests
Traversal, symlink escape, malformed/oversized protocol frames, archive traversal, unknown extension permissions, revoked grants, secret redaction, malicious project configuration, and resource exhaustion.

## 14. Definition of done

A feature is complete only when:
1. User-visible behavior is implemented, not just a button or placeholder.
2. Inputs are validated in the native trust boundary.
3. Errors, cancellation, timeouts, and shutdown are handled.
4. Tests cover normal, boundary, and failure cases.
5. Documentation accurately describes actual support and limitations.
6. Frontend CI passes; native/Windows CI passes when applicable.
7. No unrelated architecture or user data is changed.

## 15. Release gates

A public release requires:
- Reproducible dependency install, type-check, frontend build, and tests.
- Rust unit/integration tests and dependency audit.
- Clean Windows MSI build, install, launch, upgrade, uninstall, and data-preservation checks.
- Real-device verification for file system, terminal, Git, task runner, and editor workflows.
- Security, license, privacy, compatibility, and attribution review.
- Verified publisher/signing identity, checksums, release notes, and rollback plan.
- User approval before merging to `main`, publishing a release, or submitting to an app store.


## 16. Publishing, support and feedback

- The public project website and documentation are a static GitHub Pages site sourced from `docs-site/`; it is separate from the Windows desktop installer.
- The current Windows CI MSI is a development packaging artifact. Microsoft Store distribution requires a Store-compatible MSIX, verified package identity, publisher signing, Partner Center metadata, certification and approval.
- The workbench may offer a user-initiated feedback action that opens a prefilled, editable GitHub issue. Only user-entered text, app version and broad platform are included. Never attach source files, project paths, terminal output, secrets or credentials automatically.
- Feedback submission occurs in the user's browser after review and authentication. The application must not embed a GitHub token or silently create issues.
- Website deployment, signed desktop releases and Store submission are separate release pipelines with explicit approvals.
- See [Publishing and Feedback Architecture](PUBLISHING_AND_FEEDBACK_ARCHITECTURE.md) for the operational workflow and acceptance criteria.


### Native workspace save guarantees
- Native project writes use a same-directory temporary file, flush it to disk, and rename it into place to reduce the chance of partially written files after an interrupted save.
- The editor supplies the last-read file contents as a baseline. If the file changed or disappeared externally, the native save rejects the stale write rather than silently overwriting the external version.
- Project task and Run File stdout/stderr are drained concurrently into a fixed-size capture buffer. This bounds captured output memory while tasks execute. Tasks have wall-clock timeouts; Windows timeout handling uses `taskkill /T /F`, while Unix tasks are started in their own process groups and the group is terminated on timeout.
- Remaining work: process cancellation/timeouts and Windows process-tree cleanup; Run File and Git output capture still need to use the same bounded runner.
