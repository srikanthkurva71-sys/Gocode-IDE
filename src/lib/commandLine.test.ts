import { describe, expect, it } from "vitest";
import { parseCommandLineArguments } from "./commandLine";

describe("parseCommandLineArguments", () => {
  it("splits unquoted arguments on whitespace", () => {
    expect(parseCommandLineArguments("stdio --verbose  --port 6000")).toEqual(["stdio", "--verbose", "--port", "6000"]);
  });

  it("preserves quoted arguments containing spaces", () => {
    expect(parseCommandLineArguments('--config "C:\\Program Files\\tool\\config.json" \'folder with spaces/file.js\'')).toEqual([
      "--config", "C:\\Program Files\\tool\\config.json", "folder with spaces/file.js",
    ]);
  });

  it("supports empty quoted arguments and escaped quotes", () => {
    expect(parseCommandLineArguments('"" "say \\"hello\\""')).toEqual(["", 'say "hello"']);
  });

  it("rejects unmatched quotes and oversized input", () => {
    expect(() => parseCommandLineArguments('"not closed')).toThrow(/unmatched quote/);
    expect(() => parseCommandLineArguments("x".repeat(16_385))).toThrow(/16 KiB/);
  });

  it("limits the number of arguments", () => {
    expect(() => parseCommandLineArguments(Array.from({ length: 257 }, (_, i) => "a" + i).join(" "))).toThrow(/maximum 256/);
  });

  it("does not interpret shell metacharacters", () => {
    expect(parseCommandLineArguments('tool; echo "not a shell"')).toEqual(["tool;", "echo", "not a shell"]);
  });
});
