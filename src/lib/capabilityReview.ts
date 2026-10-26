export type CapabilityRisk = "high" | "medium" | "low" | "unknown";
export type CapabilityReview = { capability: string; risk: CapabilityRisk; explanation: string };

export function reviewDeclaredCapability(value: string): CapabilityReview {
  const capability = value.trim().toLowerCase();
  if (/^(process|shell|terminal|command|exec|execute)(\.|$)/.test(capability)) {
    return { capability: value, risk: "high", explanation: "May run commands or start processes." };
  }
  if (/^(network|http|https|socket|websocket|internet)(\.|$)/.test(capability)) {
    return { capability: value, risk: "high", explanation: "May communicate outside the device." };
  }
  if (/^(secrets|credentials|keychain|environment|env)(\.|$)/.test(capability)) {
    return { capability: value, risk: "high", explanation: "May access credentials or sensitive environment data." };
  }
  if (/^(filesystem|file|files)\.(write|delete|move|rename|all)(\.|$)/.test(capability)) {
    return { capability: value, risk: "high", explanation: "May modify or remove user files." };
  }
  if (/^(filesystem|file|files)\.(read|list|metadata)(\.|$)/.test(capability)) {
    return { capability: value, risk: "medium", explanation: "May read project or user files." };
  }
  if (/^(ui|editor|commands|diagnostics|completion|hover)(\.|$)/.test(capability)) {
    return { capability: value, risk: "low", explanation: "Appears limited to IDE-facing functionality, but the declaration is unverified." };
  }
  return { capability: value, risk: "unknown", explanation: "Capability meaning is not recognized; review it manually." };
}

export function reviewCapabilities(values: string[]): CapabilityReview[] {
  return values.map(reviewDeclaredCapability);
}
