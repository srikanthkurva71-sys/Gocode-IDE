import { describe, expect, it } from "vitest";
import { normalizeCompletionResult, normalizeHoverResult, normalizeReferenceLocations } from "./languageFeatures";

describe("LSP hover result normalization", () => {
  it("handles strings and MarkupContent", () => {
    expect(normalizeHoverResult({ contents: "number" })).toBe("number");
    expect(normalizeHoverResult({ contents: { kind: "markdown", value: "## docs" } })).toBe("## docs");
  });

  it("bounds hover text and ignores malformed shapes", () => {
    expect(normalizeHoverResult({ contents: "x".repeat(9000) })).toHaveLength(8000);
    expect(normalizeHoverResult({ contents: null })).toBe("");
    expect(normalizeHoverResult(null)).toBe("");
  });
});

describe("LSP completion result normalization", () => {
  it("supports arrays and CompletionList results", () => {
    expect(normalizeCompletionResult({ isIncomplete: false, items: [
      { label: "map", insertText: "map(${1:value})", detail: "transform", documentation: { kind: "markdown", value: "Maps values" } },
      { label: "filter" },
      null,
      { detail: "no label" },
    ] })).toEqual([
      { label: "map", detail: "transform", documentation: "Maps values", insertText: "map(${1:value})" },
      { label: "filter", detail: "", documentation: "", insertText: "filter" },
    ]);
  });

  it("caps item count and field sizes", () => {
    const items = Array.from({ length: 120 }, (_, index) => ({ label: "L" + index, detail: "d".repeat(1200) }));
    const result = normalizeCompletionResult(items);
    expect(result).toHaveLength(100);
    expect(result[0].detail).toHaveLength(1000);
    expect(result[0].insertText).toBe("L0");
    expect(normalizeCompletionResult({ items: "invalid" })).toEqual([]);
  });
});


import { normalizeDefinitionLocation } from "./languageFeatures";

describe("LSP definition locations", () => {
  it("normalizes a file Location inside the project", () => {
    expect(normalizeDefinitionLocation({
      uri: "file:///workspace/src/main.ts",
      range: { start: { line: 8, character: 4 }, end: { line: 8, character: 9 } },
    }, "/workspace")).toEqual({ path: "src/main.ts", line: 9, column: 5 });
  });

  it("supports LocationLink and Windows drive paths", () => {
    expect(normalizeDefinitionLocation({
      targetUri: "file:///C:/Work/demo/src/app.ts",
      targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
    }, "C:\\Work\\demo")).toEqual({ path: "src/app.ts", line: 1, column: 1 });
  });

  it("rejects outside-project paths, non-file URIs, and malformed results", () => {
    expect(normalizeDefinitionLocation({ uri: "file:///workspace-other/secret.txt", range: { start: { line: 0, character: 0 } } }, "/workspace")).toBeNull();
    expect(normalizeDefinitionLocation({ uri: "https://example.com/file", range: { start: { line: 0, character: 0 } } }, "/workspace")).toBeNull();
    expect(normalizeDefinitionLocation(null, "/workspace")).toBeNull();
  });
});


describe("LSP reference locations", () => {
  it("keeps unique project-local locations and converts positions to editor coordinates", () => {
    expect(normalizeReferenceLocations([
      { uri: "file:///workspace/src/main.ts", range: { start: { line: 1, character: 2 } } },
      { uri: "file:///workspace/src/main.ts", range: { start: { line: 1, character: 2 } } },
      { uri: "file:///workspace/lib/util.ts", range: { start: { line: 4, character: 0 } } },
      { uri: "file:///workspace-secret/private.ts", range: { start: { line: 0, character: 0 } } },
      { uri: "https://example.com/remote.ts", range: { start: { line: 0, character: 0 } } },
    ], "/workspace")).toEqual([
      { path: "src/main.ts", line: 2, column: 3 },
      { path: "lib/util.ts", line: 5, column: 1 },
    ]);
  });

  it("ignores malformed results and caps returned references", () => {
    expect(normalizeReferenceLocations(null, "/workspace")).toEqual([]);
    const many = Array.from({ length: 250 }, (_, i) => ({
      uri: `file:///workspace/src/${i}.ts`,
      range: { start: { line: 0, character: 0 } },
    }));
    expect(normalizeReferenceLocations(many, "/workspace")).toHaveLength(200);
  });
});
