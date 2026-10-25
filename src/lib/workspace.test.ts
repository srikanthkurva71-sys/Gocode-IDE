import { describe, expect, it } from "vitest";
import { findWorkspaceMatches, formatTaskOutput, isValidRelativeFileName } from "./workspace";

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
