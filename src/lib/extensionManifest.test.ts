import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "./extensionManifest";

const valid = {
  id: "sample.extension",
  name: "Sample Extension",
  version: "1.0.0",
  publisher: "Example Publisher",
  license: "MIT",
  description: "A review-only sample.",
  capabilities: ["filesystem.read", "filesystem.read"],
};

describe("validateExtensionManifest", () => {
  it("normalizes fields and de-duplicates declared capabilities", () => {
    expect(validateExtensionManifest(valid)).toMatchObject({
      id: "sample.extension",
      name: "Sample Extension",
      capabilities: ["filesystem.read"],
    });
  });

  it("rejects non-object manifests and missing fields", () => {
    expect(() => validateExtensionManifest(null)).toThrow(/JSON object/);
    expect(() => validateExtensionManifest({ ...valid, publisher: " " })).toThrow(/publisher/);
  });

  it("rejects unsafe or malformed identifiers", () => {
    for (const id of ["x", "../escape", "sample id", "bad/id", "x".repeat(81)]) {
      expect(() => validateExtensionManifest({ ...valid, id })).toThrow(/Extension id/);
    }
  });

  it("limits text and capability declarations", () => {
    expect(() => validateExtensionManifest({ ...valid, description: "x".repeat(501) })).toThrow(/500-character/);
    expect(() => validateExtensionManifest({ ...valid, capabilities: Array(33).fill("read") })).toThrow(/at most 32/);
    expect(() => validateExtensionManifest({ ...valid, capabilities: [""] })).toThrow(/Capabilities/);
  });
});
