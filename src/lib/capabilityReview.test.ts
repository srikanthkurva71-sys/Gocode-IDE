import { describe, expect, it } from "vitest";
import { reviewCapabilities, reviewDeclaredCapability } from "./capabilityReview";

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

  it("preserves declaration order for review", () => {
    expect(reviewCapabilities(["workspace.read", "network.request"]).map(item => item.risk)).toEqual(["medium", "high"]);
  });
});
