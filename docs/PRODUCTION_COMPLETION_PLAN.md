# Gocode IDE — 30-Day Production Completion Plan

**Planning window:** 2026-11-16 through 2026-12-16  
**Target:** A release-candidate-quality Windows desktop IDE, with every shipped feature tested and every deferred feature clearly disclosed.  
**Status:** Execution plan; dates are targets, not evidence that a gate has passed.

## Operating rules

- Work only on `work/gpt-extension-permissions` until the user explicitly authorizes a different branch or release action.
- Keep `main` unchanged; do not merge PR #1, force-push, or rewrite history.
- Preserve the existing Tauri 2 + React/TypeScript + Monaco + Rust architecture. Prefer small vertical slices over rewrites.
- Do not enable third-party extension execution until Windows isolation, broker authorization, revocation, resource limits, and adversarial tests pass review.
- Do not claim a test, installer, signature, Store approval, or release succeeded without recorded evidence.
- Build and validate in CI after each meaningful implementation slice. Keep the Windows MSI as a CI artifact until release approval.

## Week 1 — Baseline, correctness, and product gaps (Nov 16–22)

1. Reconcile the implementation plan with the actual repository and run all CI workflows on the current head.
2. Inventory native Tauri commands, process launch paths, plugin permissions, and frontend invoke/event usage.
3. Prioritize correctness defects in workspace/file operations, task execution, Git, LSP, DAP, and recovery.
4. Close high-value workbench gaps that can be implemented and tested safely; evaluate split editor groups, breadcrumbs/outline, and test-result navigation against the current UI architecture.
5. Add regression tests for every defect fixed and update the implementation classification only when code and tests demonstrate completion.

**Exit gate:** current CI green; no known critical/high-severity defect left without a documented mitigation; prioritized backlog and compatibility limits are explicit.

## Week 2 — Native contracts and extension security boundary (Nov 23–29)

1. Design typed native request/result/error contracts and stable error categories without changing command behavior.
2. Split native command code only where stable ownership boundaries and tests exist; avoid a mechanical 1,500-line rewrite.
3. Specify the extension worker threat model and Windows enforcement mechanism, including token/job/restricted-process controls, inherited-handle/environment policy, executable identity, working directory, and shutdown behavior.
4. Define a bounded, versioned broker protocol and map every broker method to one exact permission.
5. Implement the smallest testable authorization boundary first; default-deny every unknown or unimplemented method.

**Exit gate:** reviewed threat model and broker API inventory; native authorization tests prove ungranted and unknown operations are denied. No extension code is executed merely because the design exists.

## Week 3 — Release functionality and adversarial validation (Nov 30–Dec 6)

1. Implement only security controls that can be enforced and tested on supported Windows versions. If OS isolation cannot be demonstrated, keep extension execution disabled.
2. Expand archive tests with a maintained adversarial corpus and fuzzing where CI/runtime support is reliable.
3. Complete the highest-priority editor/workbench and test-runner gaps selected from Week 1.
4. Validate LSP/DAP interoperability only for named, reproducible server/adapter combinations; document unsupported combinations.
5. Test app startup/shutdown, child-process cleanup, workspace recovery, cancellation, and resource bounds.

**Exit gate:** repeatable tests cover the shipped feature set; no unsupported extension capability is exposed; failures are actionable and do not corrupt user project data.

## Week 4 — Windows release candidate and distribution readiness (Dec 7–16)

1. Run frontend, Rust, dependency/security audit, protocol smoke, and Windows MSI workflows on the final candidate commit.
2. Validate clean install, launch, upgrade, repair, uninstall, reinstall, and user-data preservation on clean Windows environments.
3. Verify Windows 10/11 x64 compatibility claims against the tested matrix; do not claim ARM64 support without a separate matrix.
4. Complete privacy, security, license/attribution, support, compatibility, and release notes.
5. Establish signing identity and sign the package only when a valid publisher certificate/account is available; verify signatures independently.
6. Prepare a draft release and Store submission materials. Publish or submit only after explicit user approval and required external account/certification steps.

**Exit gate:** release checklist is evidence-backed, MSI and checksum are reproducible, signing/publisher identity is verified if public distribution is claimed, and all known limitations are disclosed.

## Release scope decision

A secure extension host is a separate security-critical subsystem. If Windows-enforced isolation and broker authorization do not pass the Week 3 gate, the release candidate must keep executable extensions disabled and describe the current package inspection/catalogue features accurately. Do not weaken the isolation gate to meet the calendar date.

Microsoft Store publication is not fully controlled by repository code: Partner Center access, publisher identity, signing, listing declarations, and certification review may require user action and external processing time. The December 16 target therefore means **release-candidate and submission readiness where external prerequisites permit**, not a guarantee of Store certification by that date.

## Reporting format

For each implementation update, record:
- commit SHA and changed paths;
- exact tests/workflows run and their conclusions;
- remaining blockers and risks;
- whether the change affects release scope;
- confirmation that `main` and PR #1 remain untouched.

Progress percentages are estimates only. Completion is determined by acceptance gates, not elapsed time or a percentage.
