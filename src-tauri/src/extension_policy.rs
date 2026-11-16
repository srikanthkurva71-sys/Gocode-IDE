//! Default-deny permission vocabulary for the future extension host.
//!
//! This module deliberately does not start extension processes or grant access by
//! itself. The isolated host must call this policy before exposing each capability.

use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExtensionCapability {
    EditorRead, EditorWrite, WorkspaceRead, WorkspaceWrite,
    DiagnosticsPublish, CommandsRegister, NetworkRequest, ProcessSpawn, SecretsRead,
}

impl ExtensionCapability {
    /// Parse only exact permission identifiers. Unknown strings fail closed.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "editor.read" => Some(Self::EditorRead),
            "editor.write" => Some(Self::EditorWrite),
            "workspace.read" => Some(Self::WorkspaceRead),
            "workspace.write" => Some(Self::WorkspaceWrite),
            "diagnostics.publish" => Some(Self::DiagnosticsPublish),
            "commands.register" => Some(Self::CommandsRegister),
            "network.request" => Some(Self::NetworkRequest),
            "process.spawn" => Some(Self::ProcessSpawn),
            "secrets.read" => Some(Self::SecretsRead),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::EditorRead => "editor.read",
            Self::EditorWrite => "editor.write",
            Self::WorkspaceRead => "workspace.read",
            Self::WorkspaceWrite => "workspace.write",
            Self::DiagnosticsPublish => "diagnostics.publish",
            Self::CommandsRegister => "commands.register",
            Self::NetworkRequest => "network.request",
            Self::ProcessSpawn => "process.spawn",
            Self::SecretsRead => "secrets.read",
        }
    }

    /// Permissions that require high-visibility user consent.
    pub fn is_sensitive(self) -> bool {
        // Reading source/workspace data, editing user content, registering commands,
        // or crossing the process/network boundary all require explicit high-visibility
        // consent. Diagnostics are the only currently defined non-sensitive grant.
        !matches!(self, Self::DiagnosticsPublish)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityDecision {
    pub identifier: String,
    pub allowed: bool,
    pub sensitive: bool,
    pub reason: &'static str,
}

/// Immutable snapshot of permissions explicitly approved by the user.
#[derive(Debug, Clone, Default)]
pub struct ExtensionGrantSet {
    granted: BTreeSet<ExtensionCapability>,
}

impl ExtensionGrantSet {
    pub fn from_explicit_grants<I, S>(identifiers: I) -> Self
    where I: IntoIterator<Item = S>, S: AsRef<str> {
        let granted = identifiers.into_iter()
            .filter_map(|value| ExtensionCapability::parse(value.as_ref()))
            .collect();
        Self { granted }
    }

    pub fn allows(&self, capability: ExtensionCapability) -> bool {
        self.granted.contains(&capability)
    }

    /// Evaluate requested manifest permissions. Unknown and ungranted permissions deny.
    pub fn evaluate<I, S>(&self, requested: I) -> Vec<CapabilityDecision>
    where I: IntoIterator<Item = S>, S: AsRef<str> {
        let mut seen = BTreeSet::new();
        requested.into_iter().filter_map(|value| {
            let identifier = value.as_ref().trim().to_owned();
            if identifier.is_empty() || !seen.insert(identifier.clone()) { return None; }
            match ExtensionCapability::parse(&identifier) {
                Some(capability) if self.allows(capability) => Some(CapabilityDecision {
                    identifier, allowed: true, sensitive: capability.is_sensitive(),
                    reason: "Explicitly granted by the user.",
                }),
                Some(capability) => Some(CapabilityDecision {
                    identifier, allowed: false, sensitive: capability.is_sensitive(),
                    reason: "Permission has not been explicitly granted.",
                }),
                None => Some(CapabilityDecision {
                    identifier, allowed: false, sensitive: true,
                    reason: "Unknown permission identifiers are denied by default.",
                }),
            }
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_permissions_are_denied() {
        let decisions = ExtensionGrantSet::default().evaluate(["workspace.read", "filesystem.anything", "*"]);
        assert_eq!(decisions.len(), 3);
        assert!(decisions.iter().all(|decision| !decision.allowed));
        assert!(decisions[1].sensitive);
    }

    #[test]
    fn only_explicit_grants_are_allowed() {
        let grants = ExtensionGrantSet::from_explicit_grants(["editor.read"]);
        let decisions = grants.evaluate(["editor.read", "editor.write"]);
        assert!(decisions[0].allowed);
        assert!(decisions[0].sensitive);
        assert!(!decisions[1].allowed);
    }

    #[test]
    fn sensitive_permissions_are_marked_for_consent_ui() {
        let grants = ExtensionGrantSet::from_explicit_grants(["network.request", "process.spawn"]);
        let decisions = grants.evaluate(["network.request", "process.spawn"]);
        assert!(decisions.iter().all(|decision| decision.allowed && decision.sensitive));
    }

    #[test]
    fn duplicate_requests_are_deduplicated_and_trimmed() {
        let grants = ExtensionGrantSet::from_explicit_grants(["workspace.read"]);
        let decisions = grants.evaluate([" workspace.read ", "workspace.read", ""]);
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].identifier, "workspace.read");
    }

    #[test]
    fn only_diagnostics_publish_is_non_sensitive() {
        for capability in [
            ExtensionCapability::EditorRead,
            ExtensionCapability::EditorWrite,
            ExtensionCapability::WorkspaceRead,
            ExtensionCapability::WorkspaceWrite,
            ExtensionCapability::CommandsRegister,
            ExtensionCapability::NetworkRequest,
            ExtensionCapability::ProcessSpawn,
            ExtensionCapability::SecretsRead,
        ] {
            assert!(capability.is_sensitive(), "{} should require high-visibility consent", capability.as_str());
        }
        assert!(!ExtensionCapability::DiagnosticsPublish.is_sensitive());
    }

    #[test]
    fn unknown_grants_are_ignored_and_never_authorize_unknown_requests() {
        let grants = ExtensionGrantSet::from_explicit_grants(["editor.read", "future.permission"]);
        assert!(grants.allows(ExtensionCapability::EditorRead));
        assert!(!grants.evaluate(["future.permission"])[0].allowed);
    }
}
