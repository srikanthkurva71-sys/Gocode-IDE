# Gocode IDE

Gocode IDE is a free, local-first development environment in active development.

## Current prototype

The current development branch contains an early React + TypeScript + Vite interface with an editable text buffer, basic panels, browser-local text persistence, a download action for the current file, and a GitHub Actions frontend build check.

## Important limitations

This is not yet a complete desktop IDE. The current browser prototype does **not** access the user's real filesystem, execute shell commands, compile programs, provide a real language server/debugger, install extensions, or produce a Windows installer. Some interface panels are placeholders.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
npm run build
```

## Project principles

- Free to use; no subscription or advertising tiers are planned.
- Local-first: project files should not be uploaded to external services without explicit user action and disclosure.
- External AI providers, if added, may have their own terms and charges.
- Compatibility, installer signing, and Windows version support must be verified before being promised.
