# Windows Compatibility Policy

## Initial targets
Prioritize supported Windows 11 and supported Windows 10 configurations. Compatibility claims require clean-machine testing; a Linux frontend build does not establish Windows compatibility.

## Legacy targets
Windows 7, Windows 8, and Windows 8.1 are uncommitted legacy targets until Tauri/runtime dependencies, TLS/network behavior, signing, updates, installation, and language toolchains are verified. Windows 9 was never released. Windows 10 standard support ended on 14 October 2025; clearly communicate OS security limitations.

## Test matrix
- Clean install, launch, upgrade, uninstall.
- x64/ARM64 only where real build and test infrastructure supports them.
- File paths with spaces and non-ASCII characters; encoding and line endings.
- Terminal launch/cancel/exit status; offline startup with installed tools.
- High-DPI, small windows, keyboard navigation and accessible labels.
