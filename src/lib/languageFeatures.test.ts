import { describe, expect, it } from "vitest";
import { normalizeCompletionResult, normalizeHoverResult } from "./languageFeatures";

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
      { label: "map", detail: "transform", documentation: { kind: "markdown", value: "Maps values" } },
      { label: "filter" },
      null,
      { detail: "no label" },
    ] })).toEqual([
      { label: "map", detail: "transform", documentation: "Maps values" },
      { label: "filter", detail: "", documentation: "" },
    ]);
  });

  it("caps item count and field sizes", () => {
    const items = Array.from({ length: 120 }, (_, index) => ({ label: "L" + index, detail: "d".repeat(1200) }));
    const result = normalizeCompletionResult(items);
    expect(result).toHaveLength(100);
    expect(result[0].detail).toHaveLength(1000);
    expect(normalizeCompletionResult({ items: "invalid" })).toEqual([]);
  });
});
