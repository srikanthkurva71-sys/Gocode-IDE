import { describe, expect, it } from "vitest";
import { reviewCapabilities, reviewDeclaredCapability } from "./capabilityReview";

describe("reviewDeclaredCapability", () => {
  it("flags process, network, credential, and destructive filesystem access as high risk", () => {
    for (const value of ["process.execute", "network.http", "secrets.read", "filesystem.write"]) {
      expect(reviewDeclaredCapability(value).risk).toBe("high");
    }
  });

  it("distinguishes file reads and common IDE-facing capabilities", () => {
    expect(reviewDeclaredCapability("filesystem.read").risk).toBe("medium");
    expect(reviewDeclaredCapability("editor.commands").risk).toBe("low");
  });

  it("does not treat unknown capability names as safe", () => {
    expect(reviewDeclaredCapability("magic.full-access").risk).toBe("unknown");
  });

  it("preserves declaration order for review", () => {
    expect(reviewCapabilities(["filesystem.read", "network.http"]).map(item => item.risk)).toEqual(["medium", "high"]);
  });
});
