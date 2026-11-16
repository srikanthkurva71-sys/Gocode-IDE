# Open VSX integration decision

**Decision date:** 2026-11-16  
**Provider:** Eclipse Open VSX public registry  
**Registry URL:** https://open-vsx.org/  
**API origin:** https://open-vsx.org/api/

## Decision

Use Open VSX as Gocode IDE's first extension discovery provider. It is vendor-neutral, open-source, designed for VS Code-compatible editors, and its public registry is available without a fee for consuming or publishing extensions. Every extension remains subject to its own licence and publisher terms.

The Microsoft Visual Studio Marketplace is not selected as the primary provider. Its marketplace service is proprietary and its supported use is tied to Microsoft products; Gocode IDE should use an openly governed registry rather than depend on an unsupported Marketplace integration.

## Current integration scope

- User-submitted, read-only search against `GET /api/-/search`.
- Maximum 20 results per request; sort by download count.
- Display metadata is bounded and treated as untrusted.
- Each result links to its Open VSX detail page for publisher, version and licence review.
- No account, API key, payment, package download, installation, update, or execution is performed.
- Requests are made only after the user submits a search.
- Network access is limited in the Tauri CSP to the Open VSX origin.

## Security and compatibility gates before installation

Open VSX is a distribution source, not a security guarantee. A registry result or download count does not prove that an extension is safe, authentic, maintained, or compatible. Before package installation is enabled, Gocode IDE must implement:

1. Strict VSIX archive validation and extraction protections (path traversal, symlinks, file count, expanded size and compression-ratio limits).
2. Package digest/signature verification where registry metadata provides it, with publisher provenance checks.
3. API compatibility declaration and host API version policy.
4. Install-disabled-by-default lifecycle and explicit permission review.
5. Native broker authorization for every privileged operation.
6. Windows-enforced worker isolation, resource limits, revocation and adversarial tests.

Until those gates pass, the catalogue is discovery-only and extension code must not execute.
