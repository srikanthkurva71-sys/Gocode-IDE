# Gocode IDE — Publishing, Support and Feedback Architecture

**Status:** Target design and initial feedback implementation

## 1. Separate distribution products

- **GitHub Pages:** static product website, documentation, privacy/security policies, support links, release notes and verified download links.
- **Windows desktop app:** signed Windows package. The current CI builds an MSI for development validation. Microsoft Store distribution requires a Store-compatible MSIX package, stable package identity, publisher signing, Store metadata, certification and approval.

A Pages URL is not an installer and does not publish the desktop application to Microsoft Store. The Store listing should link to the official website, support and privacy pages.

## 2. Website

The site is static HTML/CSS with no backend, login, cookies, analytics or tracking by default. Source is in `docs-site/`. Deployment runs from the default branch after GitHub Pages is enabled in repository settings. Release links must point only to verified assets. The site must distinguish development builds from approved releases.

## 3. Feedback integration

The app's **Send Feedback** action builds a prefilled GitHub new-issue URL. It includes only:
- User-selected category (bug, feature request, general feedback).
- Text explicitly entered by the user.
- App version and broad execution surface (Windows desktop or browser preview).

It never automatically attaches project files, source code, file paths, terminal output, environment variables, credentials, tokens or machine identifiers.

The user's browser opens the editable GitHub issue page. The user reviews and submits it after GitHub authentication. No personal access token is embedded in the app and no issue is silently created. Public issue visibility follows repository settings; users must not submit secrets or private data.

## 4. Review lifecycle

1. Triage new issues into bug, feature request, question or usability feedback.
2. Request only minimal reproduction steps and expected/actual behavior.
3. Confirm accepted scope and milestone.
4. Link implementation branch and pull request.
5. Record verification evidence and supported OS/version.
6. Close only after the fix is verified and its release/commit is linked.

Do not promise response times until maintainers establish support capacity. Never request passwords, access tokens, private keys or complete private project archives.

## 5. Microsoft Store readiness

Before submission:
- Produce Store-compatible MSIX with package identity and publisher matching the Partner Center account.
- Configure version, architecture, display name, logos and capabilities.
- Sign and validate with the required publisher identity.
- Test clean install, launch, update, uninstall, offline behavior and user-data preservation.
- Prepare accurate screenshots, description, privacy policy, support URL and release notes.
- Submit through Microsoft Partner Center and wait for certification.

The existing MSI workflow is a CI artifact/smoke-test path, not a Store submission workflow. Do not upload MSI as though it were MSIX.

## 6. Release automation and credentials

CI validates pull requests and development branches. Tagged release workflows should build immutable assets, generate SHA-256 checksums and publish notes only after approval. Signing secrets belong only in protected GitHub Actions secrets or the official Store publishing integration. Never commit certificates, passwords, tokens or signing keys. Website deployment and app release remain separate workflows.

## 7. Acceptance criteria

- Feedback opens the correct repository issue form with editable title/body.
- Empty and oversized feedback are rejected and special characters are encoded.
- No project or diagnostic data is attached automatically.
- Pages deploys from the default branch after repository configuration.
- Store package identity/signing are validated before submission.
- Website, MSI, MSIX and Store listing status are described separately and accurately.
