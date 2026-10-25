import { describe, expect, it } from "vitest";
import { findWorkspaceMatches, formatTaskOutput, isValidRelativeFileName, isWithinTextImportLimit, mergeWorkspaceFiles, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_CHARS, sanitizeWorkspaceFiles } from "./workspace";

describe("isValidRelativeFileName", () => {
  it("accepts simple and nested relative paths", () => {
    expect(isValidRelativeFileName("main.ts")).toBe(true);
    expect(isValidRelativeFileName("src/components/App.tsx")).toBe(true);
  });

  it("rejects empty names and traversal segments", () => {
    expect(isValidRelativeFileName("")).toBe(false);
    expect(isValidRelativeFileName("/root/secret.txt")).toBe(false);
    expect(isValidRelativeFileName("C:/Windows/secret.txt")).toBe(false);
    expect(isValidRelativeFileName("D:relative.txt")).toBe(false);
    expect(isValidRelativeFileName("src/file:name.ts")).toBe(false);
    expect(isValidRelativeFileName("CON")).toBe(false);
    expect(isValidRelativeFileName("__proto__")).toBe(false);
    expect(isValidRelativeFileName("nul.txt")).toBe(false);
    expect(isValidRelativeFileName("folder/LPT1.log")).toBe(false);
    expect(isValidRelativeFileName("trailing-dot.")).toBe(false);
    expect(isValidRelativeFileName("trailing-space ")).toBe(false);
    expect(isValidRelativeFileName("   ")).toBe(false);
    expect(isValidRelativeFileName("../secret.txt")).toBe(false);
    expect(isValidRelativeFileName("src/../secret.txt")).toBe(false);
    expect(isValidRelativeFileName("src//main.ts")).toBe(false);
  });

  it("rejects backslashes in path segments", () => {
    expect(isValidRelativeFileName("src\\main.ts")).toBe(false);
  });
});

describe("findWorkspaceMatches", () => {
  const files = {
    "src/App.tsx": "const Greeting = 'Hello';",
    "README.md": "A local-first IDE",
    "main.rs": "fn main() {}",
  };

  it("matches case-insensitively in file names and contents", () => {
    expect(findWorkspaceMatches(files, "HELLO")).toEqual([
      ["src/App.tsx", "const Greeting = 'Hello';"],
    ]);
    expect(findWorkspaceMatches(files, "README")).toEqual([
      ["README.md", "A local-first IDE"],
    ]);
  });

  it("returns no matches when the query is absent", () => {
    expect(findWorkspaceMatches(files, "missing")).toEqual([]);
  });

  it("returns every buffer for an empty query, matching current UI semantics", () => {
    expect(findWorkspaceMatches(files, "")).toHaveLength(3);
  });
});

describe("formatTaskOutput", () => {
  it("separates command and output with real line breaks", () => {
    expect(formatTaskOutput(true, "npm test", "Tests passed")).toBe("SUCCESS: npm test\n\nTests passed");
  });

  it("labels failed tasks clearly", () => {
    expect(formatTaskOutput(false, "cargo test", "1 test failed")).toBe("FAILED: cargo test\n\n1 test failed");
  });
});

describe("isWithinTextImportLimit", () => {
  it("accepts sizes from zero through the 2 MB limit", () => {
    expect(isWithinTextImportLimit(0)).toBe(true);
    expect(isWithinTextImportLimit(MAX_WORKSPACE_FILE_CHARS)).toBe(true);
  });

  it("rejects oversized, negative, and non-finite sizes", () => {
    expect(isWithinTextImportLimit(MAX_WORKSPACE_FILE_CHARS + 1)).toBe(false);
    expect(isWithinTextImportLimit(-1)).toBe(false);
    expect(isWithinTextImportLimit(Number.NaN)).toBe(false);
    expect(isWithinTextImportLimit(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("sanitizeWorkspaceFiles", () => {
  it("keeps only valid relative paths with text contents", () => {
    expect(sanitizeWorkspaceFiles({
      "src/main.ts": "console.log('ok')",
      "../outside.txt": "blocked",
      "C:/Windows/file.txt": "blocked",
      "CON.txt": "blocked",
      "object.txt": 42,
    })).toEqual({ "src/main.ts": "console.log('ok')" });
  });

  it("rejects non-object and array inputs", () => {
    expect(sanitizeWorkspaceFiles(null)).toEqual({});
    expect(sanitizeWorkspaceFiles("not files")).toEqual({});
    expect(sanitizeWorkspaceFiles(["one", "two"])).toEqual({});
  });

  it("skips individual files that exceed the safe size limit", () => {
    expect(sanitizeWorkspaceFiles({
      "small.txt": "ok",
      "large.txt": "x".repeat(MAX_WORKSPACE_FILE_CHARS + 1),
    })).toEqual({ "small.txt": "ok" });
  });

  it("caps the number of imported workspace files", () => {
    const input: Record<string, string> = {};
    for (let index = 0; index < MAX_WORKSPACE_FILES + 10; index++) input[`file-${index}.txt`] = "ok";
    expect(Object.keys(sanitizeWorkspaceFiles(input))).toHaveLength(MAX_WORKSPACE_FILES);
  });
});

describe("mergeWorkspaceFiles", () => {
  it("prioritizes incoming files when the workspace file cap is reached", () => {
    const current: Record<string, string> = {};
    for (let index = 0; index < MAX_WORKSPACE_FILES; index++) current[`old-${index}.txt`] = "old";
    const merged = mergeWorkspaceFiles(current, { "new-file.ts": "new" });
    expect(Object.keys(merged)).toHaveLength(MAX_WORKSPACE_FILES);
    expect(merged["new-file.ts"]).toBe("new");
    expect(merged["old-0.txt"]).toBeUndefined();
  });

  it("sanitizes both existing and incoming file records", () => {
    expect(mergeWorkspaceFiles(
      { "safe.txt": "keep", "../bad.txt": "reject" },
      { "new.txt": "added", "C:/outside.txt": "reject" },
    )).toEqual({ "safe.txt": "keep", "new.txt": "added" });
  });
});
