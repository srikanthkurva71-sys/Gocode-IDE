# Extension Host Permission Design

Status: implementation foundation only. Executable extensions remain disabled.

## Security boundary

Extension manifests are untrusted input. A declaration is a request, not proof of publisher identity, permission, or safety. The existing frontend capability-risk labels are advisory only.

The extension host must run out of process with a narrow RPC protocol. Extension code must never execute in the workbench's React/WebView process or receive a general-purpose Tauri command handle.

## Permission vocabulary

The native policy module defines exact identifiers:

| Identifier | Intended scope | Default |
|---|---|---|
| `editor.read` | Read editor data explicitly exposed by the host | Deny |
| `editor.write` | Apply bounded, user-visible editor edits | Deny |
| `workspace.read` | Read selected-workspace files through scoped APIs | Deny |
| `workspace.write` | Write files through scoped, conflict-aware APIs | Deny |
| `diagnostics.publish` | Publish bounded diagnostics | Deny |
| `commands.register` | Register namespaced commands | Deny |
| `network.request` | Make outbound requests through a broker | Deny |
| `process.spawn` | Start declared tool processes through a broker | Deny |
| `secrets.read` | Access individually selected secrets | Deny |

Unknown identifiers, wildcard permissions, and broad legacy labels are denied. Grants are explicit, per extension, and revocable. Sensitive grants require clear consent explanations and should be requested only when the feature is invoked.

## Required host design

1. **Package validation:** enforce size limits, safe archive paths, file-count limits, manifest schema/version, publisher metadata, and cryptographic package integrity. Never treat a display name or self-declared publisher as verified identity.
2. **Process isolation:** launch a dedicated extension worker with a restricted environment, no inherited secrets, bounded memory/CPU/time, controlled working directory, and explicit shutdown. Do not claim OS sandboxing until Windows enforcement is implemented and tested.
3. **Brokered APIs:** expose only typed RPC methods. The worker cannot access raw filesystem paths, arbitrary shell commands, Tauri internals, or unrestricted network APIs.
4. **Authorization:** evaluate every requested permission against a user-approved grant snapshot at the native boundary. Unknown and missing grants fail closed. Re-check revocation for long-lived sessions.
5. **Resource limits:** cap message sizes, request rates, outstanding calls, logs, diagnostics, and extension storage. Apply timeouts and cancellation.
6. **Lifecycle:** install disabled; show publisher, version, license, package hash, permissions, and risk; require a separate enable action; support disable/uninstall and revoke grants.
7. **Updates:** never silently replace executable extension code. Verify signatures/hashes, show changed permissions, and require renewed consent when permissions expand.
8. **Auditability:** log extension ID, requested operation, decision, and result without logging document contents, tokens, credentials, or environment secrets.

## Current code

`src-tauri/src/extension_policy.rs` provides a pure Rust, default-deny permission vocabulary and decision evaluator. It is not yet connected to a process host or Tauri command. Unit tests cover unknown permission denial, explicit grants, sensitive permission classification, duplicate normalization, and unknown grant rejection.\n\n`src-tauri/src/extension_archive_policy.rs` validates archive-entry metadata supplied by a future ZIP reader. It rejects unsafe/absolute/traversal paths, Windows device names, duplicate and case-colliding paths, symlinks, encrypted members, excessive entry counts, oversized files and total expanded size, excessive compression ratios, and file/directory prefix conflicts. Limits are 2,048 entries, 10 MiB per file, 50 MiB total expanded data, and a 100:1 compression ratio. This is a policy layer only: it does not parse ZIP bytes, extract files, verify package signatures, or install/execute extensions. A future extractor must use a fresh private staging directory and must not follow symlinks.

## Release gates

- No executable extension support until a Windows process-isolation design is implemented and independently reviewed.
- Add package/archive fuzz tests and malicious-path tests.
- Add broker authorization tests for every native API.
- Test process termination, resource exhaustion, revocation, crash recovery, and update rollback on clean Windows machines.
- Keep extension execution disabled if any isolation or authorization check is unavailable.
