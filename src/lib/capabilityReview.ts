export type CapabilityRisk = "high" | "medium" | "low" | "unknown";
export type CapabilityReview = { capability: string; risk: CapabilityRisk; explanation: string };

const KNOWN_CAPABILITIES: Record<string, Omit<CapabilityReview, "capability">> = {
  "editor.read": {
    risk: "medium",
    explanation: "May read source code and the active editor contents.",
  },
  "editor.write": {
    risk: "high",
    explanation: "May modify source code and user-visible editor contents.",
  },
  "workspace.read": {
    risk: "medium",
    explanation: "May read files from the selected project workspace.",
  },
  "workspace.write": {
    risk: "high",
    explanation: "May create, modify, or remove project files through host APIs.",
  },
  "diagnostics.publish": {
    risk: "low",
    explanation: "May publish bounded diagnostics in the IDE.",
  },
  "commands.register": {
    risk: "high",
    explanation: "May add commands that appear in the IDE command surface.",
  },
  "network.request": {
    risk: "high",
    explanation: "May communicate with external network services through a broker.",
  },
  "process.spawn": {
    risk: "high",
    explanation: "May start declared processes through a host broker.",
  },
  "secrets.read": {
    risk: "high",
    explanation: "May access individually selected credentials or secrets.",
  },
};

export function reviewDeclaredCapability(value: string): CapabilityReview {
  const capability = value.trim();
  const known = Object.prototype.hasOwnProperty.call(KNOWN_CAPABILITIES, capability)
    ? KNOWN_CAPABILITIES[capability]
    : undefined;
  if (!known) {
    return {
      capability: value,
      risk: "unknown",
      explanation: "Capability is not in the supported permission vocabulary; treat it as untrusted.",
    };
  }
  return { capability: value, ...known };
}

export function reviewCapabilities(values: string[]): CapabilityReview[] {
  return values.map(reviewDeclaredCapability);
}
