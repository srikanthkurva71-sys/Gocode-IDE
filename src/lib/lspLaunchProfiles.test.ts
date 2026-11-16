import { describe, expect, it } from "vitest";
import {
  containsSecretLikeLspArgument,
  loadLspLaunchProfiles,
  upsertLspLaunchProfile,
  validateLspLaunchProfile,
  type LspLaunchProfile,
} from "./lspLaunchProfiles";

const valid = {
  name: "Rust Analyzer",
  executable: "C:/Users/dev/.cargo/bin/rust-analyzer.exe",
  args: ["--log-file", "C:/temp/rust-analyzer.log"],
};

describe("LSP launch profiles", () => {
  it("validates and returns detached profiles for Windows and POSIX paths", () => {
    const windows = validateLspLaunchProfile(valid);
    expect(windows).toEqual(valid);
    expect(windows.args).not.toBe(valid.args);
    expect(validateLspLaunchProfile({
      name: "Rust Analyzer",
      executable: "/usr/local/bin/rust-analyzer",
      args: [],
    }).executable).toBe("/usr/local/bin/rust-analyzer");
  });

  it("rejects relative executable paths, invalid names, and invalid arguments", () => {
    expect(() => validateLspLaunchProfile({ ...valid, executable: "rust-analyzer" })).toThrow(/absolute path/);
    expect(() => validateLspLaunchProfile({ ...valid, name: " " })).toThrow(/Profile name/);
    expect(() => validateLspLaunchProfile({ ...valid, args: ["bad\0arg"] })).toThrow(/arguments/);
    expect(() => validateLspLaunchProfile({ ...valid, args: Array(65).fill("--stdio") })).toThrow(/64 strings/);
  });

  it("does not persist secret-like launch arguments", () => {
    expect(containsSecretLikeLspArgument(["--stdio"])).toBe(false);
    expect(containsSecretLikeLspArgument(["--api-key=abc"])).toBe(true);
    expect(containsSecretLikeLspArgument(["--password", "abc"])).toBe(true);
    expect(() => validateLspLaunchProfile({ ...valid, args: ["--access-token=abc"] })).toThrow(/credentials/);
  });

  it("upserts names case-insensitively and enforces the profile limit", () => {
    const first = upsertLspLaunchProfile([], valid);
    const second = upsertLspLaunchProfile(first, { ...valid, name: "RUST ANALYZER", args: [] });
    expect(second).toHaveLength(1);
    expect(second[0].args).toEqual([]);

    let profiles: LspLaunchProfile[] = [];
    for (let index = 0; index < 20; index++) {
      profiles = upsertLspLaunchProfile(profiles, { ...valid, name: "Profile " + index });
    }
    expect(() => upsertLspLaunchProfile(profiles, { ...valid, name: "Profile 21" })).toThrow(/maximum of 20/);
  });

  it("loads valid profiles, removes duplicates, and skips corrupt entries", () => {
    const raw = JSON.stringify([
      valid,
      { ...valid, name: "rust analyzer" },
      { ...valid, name: "Relative", executable: "rust-analyzer" },
      { ...valid, name: "With secret", args: ["--token=abc"] },
    ]);
    expect(loadLspLaunchProfiles(raw)).toEqual([valid]);
    expect(loadLspLaunchProfiles("not-json")).toEqual([]);
    expect(loadLspLaunchProfiles(JSON.stringify({ ...valid }))).toEqual([]);
    expect(loadLspLaunchProfiles("x".repeat(700_000))).toEqual([]);
  });
});
