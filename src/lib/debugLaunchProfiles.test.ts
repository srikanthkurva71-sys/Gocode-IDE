import { describe, expect, it } from "vitest";
import { loadDebugLaunchProfiles, upsertDebugLaunchProfile, validateDebugLaunchProfile, type DebugLaunchProfile } from "./debugLaunchProfiles";

const valid = {
  name: "Node launch",
  executable: "C:/tools/node-debug-adapter.cmd",
  adapterArgs: ["--stdio"],
  request: "launch",
  configuration: { program: "C:/work/app.js", stopOnEntry: true },
};

describe("debug launch profiles", () => {
  it("validates and returns a detached JSON-safe profile", () => {
    const profile = validateDebugLaunchProfile(valid);
    expect(profile).toEqual(valid);
    expect(profile.adapterArgs).not.toBe(valid.adapterArgs);
    expect(profile.configuration).not.toBe(valid.configuration);
  });

  it("upserts names case-insensitively without duplicate profiles", () => {
    const first = upsertDebugLaunchProfile([], valid);
    const second = upsertDebugLaunchProfile(first, { ...valid, name: "NODE LAUNCH", configuration: { program: "next.js" } });
    expect(second).toHaveLength(1);
    expect(second[0].configuration).toEqual({ program: "next.js" });
  });

  it("rejects invalid names, executables, arguments and request types", () => {
    expect(() => validateDebugLaunchProfile({ ...valid, name: " " })).toThrow(/Profile name/);
    expect(() => validateDebugLaunchProfile({ ...valid, executable: "" })).toThrow(/executable/);
    expect(() => validateDebugLaunchProfile({ ...valid, adapterArgs: ["x".repeat(4097)] })).toThrow(/arguments/);
    expect(() => validateDebugLaunchProfile({ ...valid, request: "restart" })).toThrow(/launch or attach/);
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: [] })).toThrow(/JSON object/);
  });

  it("rejects unsafe property names and non-finite values", () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: unsafe })).toThrow(/unsafe property/);
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: { timeout: Infinity } })).toThrow(/finite/);
  });

  it("enforces nesting, property, array and total byte limits", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 10; index++) nested = { child: nested };
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: nested })).toThrow(/nested too deeply/);
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: { values: Array(201).fill(1) } })).toThrow(/200 entries/);
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: { value: "x".repeat(8192) } })).not.toThrow();
    expect(() => validateDebugLaunchProfile({ ...valid, configuration: { value: "x".repeat(8193) } })).toThrow(/8192 characters/);
  });


  it("persists credential-free profiles and reloads them across app sessions", () => {
    const profiles = upsertDebugLaunchProfile([], valid);
    expect(loadDebugLaunchProfiles(JSON.stringify(profiles))).toEqual(profiles);
    expect(loadDebugLaunchProfiles("not-json")).toEqual([]);
    expect(loadDebugLaunchProfiles(JSON.stringify({ ...valid }))).toEqual([]);
  });

  it("rejects credential-like adapter arguments and nested configuration fields from persistence", () => {
    expect(() => validatePersistableDebugLaunchProfile({ ...valid, adapterArgs: ["--api-key=abc"] })).toThrow(/cannot be saved/);
    expect(() => validatePersistableDebugLaunchProfile({
      ...valid,
      configuration: { launch: { env: { ACCESS_TOKEN: "abc" } } },
    })).toThrow(/credential-like field/);
    expect(() => validatePersistableDebugLaunchProfile({
      ...valid,
      configuration: { headers: { Authorization: "Bearer abc" } },
    })).toThrow(/credential-like field/);
    expect(() => validateDebugLaunchProfile({
      ...valid,
      configuration: { env: { ACCESS_TOKEN: "session-only" } },
    })).not.toThrow();
  });

  it("ignores unsafe and duplicate persisted entries while keeping valid profiles", () => {
    const raw = JSON.stringify([
      valid,
      { ...valid, name: "node launch" },
      { ...valid, name: "Secret profile", configuration: { token: "abc" } },
      { ...valid, name: "Relative data", configuration: { password: "abc" } },
    ]);
    expect(loadDebugLaunchProfiles(raw)).toEqual([validateDebugLaunchProfile(valid)]);
    expect(loadDebugLaunchProfiles("x".repeat(64 * 1024 * 21))).toEqual([]);
  });

  it("caps the number of saved profiles", () => {
    let profiles: DebugLaunchProfile[] = [];
    for (let index = 0; index < 20; index++) {
      profiles = upsertDebugLaunchProfile(profiles, { ...valid, name: "Profile " + index });
    }
    expect(() => upsertDebugLaunchProfile(profiles, { ...valid, name: "Profile 21" })).toThrow(/maximum of 20/);
  });
});
