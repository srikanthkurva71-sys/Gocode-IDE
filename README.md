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
- Monaco editor with language-aware syntax highlighting for common programming languages.
- Browser-local multi-file buffers, persistence, file import/download, workspace backup import/export, and basic search/replace.
- Initial native desktop open/save dialogs using the Tauri dialog and filesystem plugins.
- Branded blue G monogram for the workbench, browser favicon, and Windows application icon.
- Initial Tauri 2 / Rust desktop-shell scaffolding.
- Windows MSI GitHub Actions workflow that is being tested.
- Automated frontend type-check/build workflow.
- Architecture, security, privacy, Windows compatibility, and release planning documents.

**This is not yet a complete IDE.** The workbench remains an early prototype. Native open/save is implemented but still needs Windows runtime testing. The terminal, debugger, Git operations, compiler/toolchain adapters, extension host, and language-server integration are not implemented. The Windows MSI workflow is still being verified; do not treat a queued/running workflow as a successful installer.

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
