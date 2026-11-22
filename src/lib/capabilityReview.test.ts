import { describe, expect, it } from "vitest";
import { reviewCapabilities, reviewDeclaredCapability, summarizeCapabilityRisks } from "./capabilityReview";

describe("reviewDeclaredCapability", () => {
  it("marks process, network, credentials, writes, and command registration as high risk", () => {
    for (const value of [
      "process.spawn",
      "network.request",
      "secrets.read",
      "workspace.write",
      "editor.write",
      "commands.register",
    ]) {
      expect(reviewDeclaredCapability(value).risk).toBe("high");
    }
  });

  it("distinguishes source/workspace reads from bounded diagnostics", () => {
    expect(reviewDeclaredCapability("editor.read").risk).toBe("medium");
    expect(reviewDeclaredCapability("workspace.read").risk).toBe("medium");
    expect(reviewDeclaredCapability("diagnostics.publish").risk).toBe("low");
  });

  it("does not infer safety from an unknown capability prefix", () => {
    for (const value of ["magic.full-access", "editor.commands", "workspace.admin", "network.anything"]) {
      expect(reviewDeclaredCapability(value).risk).toBe("unknown");
    }
  });

  it("requires exact identifiers and treats whitespace-padded names as unknown", () => {
    expect(reviewDeclaredCapability(" editor.read ").risk).toBe("unknown");
    expect(reviewDeclaredCapability("diagnostics.publish ").risk).toBe("unknown");
  });

  it("treats JavaScript object prototype keys as unknown capabilities", () => {
    for (const value of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(reviewDeclaredCapability(value).risk).toBe("unknown");
    }
  });

  it("preserves declaration order for review", () => {
    expect(reviewCapabilities(["workspace.read", "network.request"]).map(item => item.risk)).toEqual(["medium", "high"]);
  });
});


describe("summarizeCapabilityRisks", () => {
  it("counts each risk level and requires review for high or unknown permissions", () => {
    expect(summarizeCapabilityRisks([
      "diagnostics.publish",
      "editor.read",
      "editor.write",
      "mystery.permission",
    ])).toEqual({
      total: 4,
      low: 1,
      medium: 1,
      high: 1,
      unknown: 1,
      requiresManualReview: true,
    });
  });

  it("does not require manual review for only known low-risk capabilities", () => {
    expect(summarizeCapabilityRisks(["diagnostics.publish"])).toEqual({
      total: 1,
      low: 1,
      medium: 0,
      high: 0,
      unknown: 0,
      requiresManualReview: false,
    });
  });

  it("handles an empty capability list", () => {
    expect(summarizeCapabilityRisks([])).toEqual({
      total: 0,
      low: 0,
      medium: 0,
      high: 0,
      unknown: 0,
      requiresManualReview: false,
    });
  });
});
