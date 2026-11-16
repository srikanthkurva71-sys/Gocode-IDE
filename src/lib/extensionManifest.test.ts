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

  it("requires a valid semantic version and rejects malformed version strings", () => {
    for (const version of ["1", "1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3.4"]) {
      expect(() => validateExtensionManifest({ ...valid, version })).toThrow(/semantic versioning/);
    }
    expect(validateExtensionManifest({ ...valid, version: "2.4.1-rc.2+build.7" }).version).toBe("2.4.1-rc.2+build.7");
  });

  it("rejects unknown fields and non-plain objects", () => {
    expect(() => validateExtensionManifest({ ...valid, permissions: ["*"] })).toThrow(/Unknown manifest field/);
    expect(() => validateExtensionManifest(Object.assign(Object.create({ inherited: true }), valid))).toThrow(/plain JSON object/);
  });

  it("limits text and validates capability identifiers", () => {
    expect(() => validateExtensionManifest({ ...valid, description: "x".repeat(501) })).toThrow(/500-character/);
    expect(() => validateExtensionManifest({ ...valid, capabilities: Array(33).fill("read") })).toThrow(/at most 32/);
    expect(() => validateExtensionManifest({ ...valid, capabilities: [""] })).toThrow(/Capabilities/);
    expect(() => validateExtensionManifest({ ...valid, capabilities: ["Network.HTTP"] })).toThrow(/Capabilities/);
  });

  it("rejects control characters in manifest text", () => {
    expect(() => validateExtensionManifest({ ...valid, publisher: "Publisher\nInjected" })).toThrow(/control characters/);
  });
});
