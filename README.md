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
- Browser-local multi-file buffers, persistence, file import/download, workspace backup import/export, and basic search/replace.
- Native project folder opening, bounded recursive file listing, project file reading/writing with path traversal checks and a 2 MB text-file limit.
- Bounded project-wide text search with case-insensitive matching, line-numbered results, symlink skipping, generated-folder exclusions, 1 MB per-file limit, and a 200-result cap.
- Local Git status, diff, stage-all, commit, local branch listing/switching, and user-confirmed fast-forward pull/push to `origin` through the installed Git CLI.
- Initial project-task detection and fixed build/test adapters for npm, Cargo, Python syntax compilation, Make, Go, and CMake configuration.
- Persistent editor preferences for word wrap and minimap.
- Importable extension-manifest review registry that validates basic fields and displays publisher/license/capability declarations; it does not execute or install extension code.
- Branded blue G monogram for the workbench, browser favicon, and Windows application icon.
- Initial Tauri 2 / Rust desktop-shell scaffolding.
- Windows MSI GitHub Actions workflow that is being tested.
- Automated frontend type-check/build workflow.
- Architecture, security, privacy, Windows compatibility, and release planning documents.

**This is not yet a complete IDE.** The workbench remains an early prototype. Project-wide text search is implemented with bounded scanning and line-numbered matches; it is not a language-aware symbol search. Native open/save is implemented but still needs Windows runtime testing. The native terminal now uses a PTY and xterm.js; its runtime behavior still needs a clean-Windows launch test. Git status/diff/stage/commit, local branch listing/switching, confirmed fast-forward pull/push, and initial fixed build-task adapters are implemented. A DAP debugger, external language-server integration for broader languages, and executable extension hosting remain incomplete. The Problems panel currently surfaces editor-provided diagnostics; it is not a substitute for full language-server support. The Windows MSI workflow includes a clean-runner install/launch/uninstall smoke test; the latest run passed. Manual testing on supported Windows versions is still required.

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
npm run build
```

To build the desktop application after installing prerequisites:

```sh
python scripts/generate_icon.py
npm run tauri -- build
```

Do not treat a successful frontend build as proof of Windows compatibility. The desktop package must be built and tested on Windows.
