# Gocode IDE

Gocode IDE is a free, local-first development environment in active development.

## Project principles

- No Gocode IDE subscription, advertisements, paid feature tiers, or mandatory account/OTP.
- Core editing should work locally without cloud sign-in.
- No automatic project uploads. External AI/cloud integrations must be optional and disclose what data leaves the device before a user confirms.
- External providers may have their own terms or charges; Gocode IDE itself does not charge users.
- Prefer free/open-source extensions while clearly displaying publisher, license, and permissions.
- Compatibility and release approval are claimed only after verification.

## Current implementation status

The development branch currently has:
- React + TypeScript + Vite frontend with an early editor-style UI.
- Monaco editor with language-aware syntax highlighting for common programming languages and an editor Problems panel that displays diagnostics supplied by Monaco-supported language services.
- Keyboard-driven Quick Open (`Ctrl+P` / `Cmd+P`) filters workspace and opened-project filenames, supports Escape to close, and has unit-tested filename filtering and result limits.
- Editor navigation: `Ctrl+G` / `Cmd+G` prompts for a valid line number; clicking a Problems-panel diagnostic moves the editor cursor to its reported line and column.
- Editor readability controls: persistent font size from 10–24 px, with `Ctrl+=` / `Cmd+=` to increase, `Ctrl+-` / `Cmd+-` to decrease, and `Ctrl+0` / `Cmd+0` to reset. The font-size clamp has automated boundary tests.
- Searchable command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) for opening projects, saving current/all open project files, Quick Open, Find/Replace, toggling the terminal, and switching workbench panels. Supports keyboard navigation and Enter/Escape actions.
- Multi-file editor tabs: opening a file adds a tab, clicking switches between open files, each tab can be closed without deleting its file, and `Ctrl+Tab` / `Cmd+Tab` cycles to the next open tab. `Ctrl+W` / `Cmd+W` closes the active tab without deleting its file. The status bar reports the current file language and editor cursor line/column.
- Project file editing tracks unsaved changes on open tabs, prompts before closing a modified project tab, and provides a Save All action for modified open project files. This applies to files opened from the native project Explorer; browser-workspace buffers continue to use browser storage/download behavior. Reopening a modified file also asks before discarding unsaved edits.
- Run Current File: from the native project Explorer, run Python (`.py`), JavaScript (`.js`, `.mjs`, `.cjs`), or Go (`.go`) files with their installed runtimes. Execution requires confirmation, accepts only regular files inside the opened project, and displays bounded stdout/stderr in task output. C/C++, Rust single-file execution, HTML preview, and interactive debugging are not included in this action yet.
- Browser-local multi-file buffers, persistence, file import/download, workspace backup import/export, and basic search/replace. Workspace filename validation (including Windows reserved names, drive paths, traversal, and invalid separators) and buffer search helpers have automated unit tests. Workspace backup imports are limited to 20 MB, sanitized to valid relative filenames, and capped at 500 files with a 2,000,000-character limit per imported file; individual file imports above the 2 MB text limit are skipped.
- Native project folder opening, collapsible project Explorer folders, safe project-folder creation (including nested relative paths), local remembering/restoration of the last project path, bounded recursive file listing, project file reading/writing with path traversal checks and a 2 MB text-file limit. Only the folder path is remembered; project contents are not copied to cloud storage.
- Bounded project-wide text search with case-insensitive matching, clickable line-numbered results that open the file at the matching line, symlink skipping, generated-folder exclusions, 1 MB per-file limit, and a 200-result cap.
- Local Git status, diff, stage-all, commit, local branch listing/switching, and user-confirmed fast-forward pull/push to `origin` through the installed Git CLI.
- Initial project-task detection and fixed build/test adapters for npm, Cargo, Python syntax compilation, Make, Go, and CMake configuration. Running a detected task requires explicit confirmation because project build/test commands can execute project-controlled code.
- Persistent editor preferences for word wrap and minimap.
- Importable extension-manifest review registry that validates basic fields and displays publisher/license/capability declarations; it does not execute or install extension code.
- Branded blue G monogram for the workbench, browser favicon, and Windows application icon.
- Initial Tauri 2 / Rust desktop-shell scaffolding.
- Experimental user-configured LSP process support: explicit executable/arguments, JSON-RPC framing with message-size limits, initialize/initialized handshake, document-open/change notifications, and publication of diagnostics to the Problems panel. This is an early integration and requires language-server-specific and Windows runtime testing.
- Experimental user-configured DAP process support: explicit adapter executable/arguments, JSON framing with message-size limits, initialize/launch/configurationDone flow, continue/pause requests, per-file breakpoint toggling at the editor cursor, thread listing, stack-trace/scopes requests, and an adapter event log. Dedicated call-stack and variable panes, launch-profile management, and end-to-end debugger tests are not implemented.
- Windows MSI GitHub Actions workflow that is being tested.
- Automated frontend type-check/build workflow.
- Architecture, security, privacy, Windows compatibility, and release planning documents.

**This is not yet a complete IDE.** The workbench remains an early prototype. Project-wide text search is implemented with bounded scanning and line-numbered matches; it is not a language-aware symbol search. Native open/save is implemented but still needs Windows runtime testing. The native terminal now uses a PTY and xterm.js; its runtime behavior still needs a clean-Windows launch test. Git status/diff/stage/commit, local branch listing/switching, confirmed fast-forward pull/push, and initial fixed build-task adapters are implemented. DAP support is experimental: users must install and explicitly configure a local debug adapter; basic per-file breakpoints can be toggled at the editor cursor and thread/stack/scopes requests are available, but dedicated stack-frame and variable views, launch-profile management, and end-to-end tests remain incomplete. LSP support is experimental: users must install and explicitly configure a local language-server executable; server-specific client requests/capabilities, robust URI handling, document lifecycle across multiple tabs, and end-to-end tests still need work. Executable extension hosting remains incomplete; imported manifests are only reviewed and never executed. The Problems panel can display editor diagnostics and diagnostics published by the currently connected LSP server; neither guarantees complete language support. Project build/test tasks now require a confirmation prompt before execution. Rust unit tests cover project path traversal rejection and search-query normalization/length validation. The Windows MSI workflow includes Rust tests, MSI packaging, a clean-runner install/launch/uninstall smoke test, and checksum artifact generation. The latest validated Windows MSI and frontend workflow runs passed on the development branch, including the dependency audit, automated unit tests, frontend type-check/build, and MSI install/launch/uninstall smoke test. The committed `package-lock.json` enables reproducible `npm ci` installs. CI results are useful evidence, not a replacement for manual testing on supported Windows versions. Before release, continue reviewing dependency advisories and test filesystem, terminal, Git, upgrade/uninstall, and data-preservation behavior on real Windows installations.

## Architecture and policies

- [Architecture and product requirements](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Privacy principles](docs/PRIVACY.md)
- [Windows compatibility policy](docs/COMPATIBILITY.md)
- [Release checklist](docs/RELEASE.md)
- [Language tooling, debugging, extension-host, and release acceptance plan](docs/LANGUAGE_TOOLING_AND_RELEASE_PLAN.md)

## Development

Requires Node.js 20 or newer for the frontend. Tauri desktop builds also require the Rust toolchain and platform prerequisites.

```sh
npm install
npm run dev
npm test
npm run build
```

To build the desktop application after installing prerequisites:

```sh
python scripts/generate_icon.py
npm run tauri -- build
```

Do not treat a successful frontend build as proof of Windows compatibility. The desktop package must be built and tested on Windows.
