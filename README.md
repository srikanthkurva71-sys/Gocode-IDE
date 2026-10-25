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
- Multi-file editor tabs: opening a file adds a tab, clicking switches between open files, each tab can be closed without deleting its file, and `Ctrl+Tab` / `Cmd+Tab` cycles to the next open tab.
- Browser-local multi-file buffers, persistence, file import/download, workspace backup import/export, and basic search/replace. Workspace filename validation (including Windows reserved names, drive paths, traversal, and invalid separators) and buffer search helpers have automated unit tests. Workspace backup imports are limited to 20 MB, sanitized to valid relative filenames, and capped at 500 files with a 2,000,000-character limit per imported file; individual file imports above the 2 MB text limit are skipped.
- Native project folder opening, collapsible project Explorer folders, safe project-folder creation (including nested relative paths), local remembering/restoration of the last project path, bounded recursive file listing, project file reading/writing with path traversal checks and a 2 MB text-file limit. Only the folder path is remembered; project contents are not copied to cloud storage.
- Bounded project-wide text search with case-insensitive matching, clickable line-numbered results that open the file at the matching line, symlink skipping, generated-folder exclusions, 1 MB per-file limit, and a 200-result cap.
- Local Git status, diff, stage-all, commit, local branch listing/switching, and user-confirmed fast-forward pull/push to `origin` through the installed Git CLI.
- Initial project-task detection and fixed build/test adapters for npm, Cargo, Python syntax compilation, Make, Go, and CMake configuration. Running a detected task requires explicit confirmation because project build/test commands can execute project-controlled code.
- Persistent editor preferences for word wrap and minimap.
- Importable extension-manifest review registry that validates basic fields and displays publisher/license/capability declarations; it does not execute or install extension code.
- Branded blue G monogram for the workbench, browser favicon, and Windows application icon.
- Initial Tauri 2 / Rust desktop-shell scaffolding.
- Windows MSI GitHub Actions workflow that is being tested.
- Automated frontend type-check/build workflow.
- Architecture, security, privacy, Windows compatibility, and release planning documents.

**This is not yet a complete IDE.** The workbench remains an early prototype. Project-wide text search is implemented with bounded scanning and line-numbered matches; it is not a language-aware symbol search. Native open/save is implemented but still needs Windows runtime testing. The native terminal now uses a PTY and xterm.js; its runtime behavior still needs a clean-Windows launch test. Git status/diff/stage/commit, local branch listing/switching, confirmed fast-forward pull/push, and initial fixed build-task adapters are implemented. A DAP debugger, external language-server integration for broader languages, and executable extension hosting remain incomplete. The Problems panel currently surfaces editor-provided diagnostics; it is not a substitute for full language-server support. Project build/test tasks now require a confirmation prompt before execution. Rust unit tests cover project path traversal rejection and search-query normalization/length validation. The Windows MSI workflow includes Rust tests, MSI packaging, a clean-runner install/launch/uninstall smoke test, and checksum artifact generation. The latest validated Windows MSI and frontend workflow runs passed on the development branch, including the dependency audit, automated unit tests, frontend type-check/build, and MSI install/launch/uninstall smoke test. The committed `package-lock.json` enables reproducible `npm ci` installs. CI results are useful evidence, not a replacement for manual testing on supported Windows versions. Before release, continue reviewing dependency advisories and test filesystem, terminal, Git, upgrade/uninstall, and data-preservation behavior on real Windows installations.

## Architecture and policies

- [Architecture and product requirements](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Privacy principles](docs/PRIVACY.md)
- [Windows compatibility policy](docs/COMPATIBILITY.md)
- [Release checklist](docs/RELEASE.md)

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
