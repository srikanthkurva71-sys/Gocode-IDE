import { describe, expect, it } from "vitest";
import { findWorkspaceMatches, isValidRelativeFileName } from "./workspace";

describe("isValidRelativeFileName", () => {
  it("accepts simple and nested relative paths", () => {
    expect(isValidRelativeFileName("main.ts")).toBe(true);
    expect(isValidRelativeFileName("src/components/App.tsx")).toBe(true);
  });

  it("rejects empty names and traversal segments", () => {
    expect(isValidRelativeFileName("")).toBe(false);
    expect(isValidRelativeFileName("/root/secret.txt")).toBe(false);
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
