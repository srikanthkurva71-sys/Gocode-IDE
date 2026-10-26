import { describe, expect, it } from "vitest";
import {
  normalizeDebugScopes,
  normalizeDebugStackFrames,
  normalizeDebugThreads,
  normalizeDebugVariables,
} from "./debugProtocol";

describe("debug protocol response normalization", () => {
  it("normalizes valid threads and ignores malformed entries", () => {
    expect(normalizeDebugThreads({ body: { threads: [
      { id: 4, name: "Main thread" }, { id: "bad", name: "Ignore" }, null,
    ] } })).toEqual([{ id: 4, name: "Main thread" }]);
  });

  it("normalizes stack frames and preserves source navigation data", () => {
    expect(normalizeDebugStackFrames({ body: { stackFrames: [
      { id: 7, name: "main", line: 12, column: 3, source: { path: "C:/project/main.rs" } },
      { id: 8, name: "bad", line: -2 },
    ] } })).toEqual([
      { id: 7, name: "main", line: 12, column: 3, sourcePath: "C:/project/main.rs" },
      { id: 8, name: "bad", line: 1, column: 1, sourcePath: null },
    ]);
  });

  it("normalizes scopes and variable references", () => {
    expect(normalizeDebugScopes({ body: { scopes: [
      { name: "Locals", variablesReference: 12 }, { name: "Globals", variablesReference: 0, expensive: true },
      { name: "Bad", variablesReference: -1 },
    ] } })).toEqual([
      { name: "Locals", variablesReference: 12, expensive: false },
      { name: "Globals", variablesReference: 0, expensive: true },
    ]);
  });

  it("bounds variable text and ignores malformed records", () => {
    const value = "x".repeat(5000);
    expect(normalizeDebugVariables({ body: { variables: [
      { name: "long", value, type: "String", variablesReference: 0 }, { value: "missing name" },
    ] } })).toEqual([{
      name: "long", value: "x".repeat(4000), type: "String", variablesReference: 0,
    }]);
  });

  it("handles absent or malformed response bodies", () => {
    expect(normalizeDebugThreads(null)).toEqual([]);
    expect(normalizeDebugStackFrames({ body: { stackFrames: "bad" } })).toEqual([]);
    expect(normalizeDebugScopes({})).toEqual([]);
    expect(normalizeDebugVariables({ body: null })).toEqual([]);
  });
});
