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
  const capability = value;
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


export type CapabilityRiskSummary = {
  total: number;
  low: number;
  medium: number;
  high: number;
  unknown: number;
  requiresManualReview: boolean;
};

/** Summarizes declared permissions without ever treating unknown capabilities as safe. */
export function summarizeCapabilityRisks(values: string[]): CapabilityRiskSummary {
  const reviews = reviewCapabilities(values);
  const summary: CapabilityRiskSummary = {
    total: reviews.length,
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0,
    requiresManualReview: false,
  };

  for (const review of reviews) {
    summary[review.risk] += 1;
  }
  summary.requiresManualReview = summary.high > 0 || summary.unknown > 0;
  return summary;
}
