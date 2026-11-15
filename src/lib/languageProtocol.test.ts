import { describe, expect, it } from "vitest";
import { encodeProtocolMessage, isProjectFileUri, normalizeLspDiagnostics, parseProtocolFrames } from "./languageProtocol";

describe("Content-Length protocol framing", () => {
  it("round-trips JSON-RPC payloads with non-ASCII text using UTF-8 byte lengths", () => {
    const bytes = encodeProtocolMessage({ jsonrpc: "2.0", id: 1, method: "test", params: { text: "café 🧪" } });
    const result = parseProtocolFrames(bytes);
    expect(result.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "test", params: { text: "café 🧪" } }]);
    expect(result.remainder).toHaveLength(0);
  });

  it("retains incomplete headers and bodies across reads", () => {
    const bytes = encodeProtocolMessage({ jsonrpc: "2.0", id: 7, result: "ok" });
    const first = parseProtocolFrames(bytes.slice(0, 10));
    expect(first.messages).toEqual([]);
    const second = parseProtocolFrames(new Uint8Array([...first.remainder, ...bytes.slice(10, bytes.length - 2)]));
    expect(second.messages).toEqual([]);
    const third = parseProtocolFrames(new Uint8Array([...second.remainder, ...bytes.slice(-2)]));
    expect(third.messages[0]).toMatchObject({ id: 7, result: "ok" });
  });

  it("parses multiple concatenated frames", () => {
    const a = encodeProtocolMessage({ jsonrpc: "2.0", id: 1, result: true });
    const b = encodeProtocolMessage({ jsonrpc: "2.0", id: 2, result: false });
    expect(parseProtocolFrames(new Uint8Array([...a, ...b])).messages).toHaveLength(2);
  });

  it("rejects missing or duplicate Content-Length headers", () => {
    expect(() => parseProtocolFrames(new TextEncoder().encode("X-Test: 1\r\n\r\n{}"))).toThrow(/exactly one Content-Length/);
    expect(() => parseProtocolFrames(new TextEncoder().encode("Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}"))).toThrow(/exactly one Content-Length/);
  });

  it("rejects non-JSON-RPC objects", () => {
    const frame = new TextEncoder().encode("Content-Length: 2\r\n\r\n{}");
    expect(() => parseProtocolFrames(frame)).toThrow(/JSON-RPC 2.0/);
  });
});

describe("normalizeLspDiagnostics", () => {
  it("converts zero-based LSP positions into one-based editor markers", () => {
    expect(normalizeLspDiagnostics([{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, message: "Oops", severity: 1, source: "server" }]))
      .toEqual([{ lineNumber: 1, column: 3, endLineNumber: 1, endColumn: 6, message: "Oops", severity: "error", source: "server" }]);
  });

  it("ignores malformed entries and caps diagnostics", () => {
    expect(normalizeLspDiagnostics([null, { message: "no range" }, { range: { start: { line: -1, character: -1 }, end: { line: 0, character: 0 } }, message: "safe" }])[0])
      .toMatchObject({ lineNumber: 1, column: 1 });
    expect(normalizeLspDiagnostics(Array.from({ length: 1001 }, () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "x" })))).toHaveLength(1000);
  });
});

describe("project-local LSP URI filtering", () => {
  const root = "file:///C:/work/project";

  it("accepts files below the project root, including encoded spaces", () => {
    expect(isProjectFileUri("file:///C:/work/project/src/main.rs", root)).toBe(true);
    expect(isProjectFileUri("file:///C:/work/project/folder%20name/file.ts", root + "/")).toBe(true);
  });

  it("rejects sibling paths, outside paths, non-strings, and oversized URIs", () => {
    expect(isProjectFileUri("file:///C:/work/project-old/file.ts", root)).toBe(false);
    expect(isProjectFileUri("file:///C:/work/other/file.ts", root)).toBe(false);
    expect(isProjectFileUri(null, root)).toBe(false);
    expect(isProjectFileUri("x".repeat(8193), root)).toBe(false);
    expect(isProjectFileUri("https://example.test/project/src.ts", root)).toBe(false);
  });

  it("rejects encoded traversal and encoded path separators", () => {
    expect(isProjectFileUri("file:///C:/work/project/%2e%2e/secrets.ts", root)).toBe(false);
    expect(isProjectFileUri("file:///C:/work/project/%2e%2e%2fsecrets.ts", root)).toBe(false);
    expect(isProjectFileUri("file:///C:/work/project/%5c..%5csecrets.ts", root)).toBe(false);
  });

  it("rejects different file hosts and URI query or fragment components", () => {
    expect(isProjectFileUri("file://server/C:/work/project/src.ts", root)).toBe(false);
    expect(isProjectFileUri("file:///C:/work/project/src.ts?download=1", root)).toBe(false);
    expect(isProjectFileUri("file:///C:/work/project/src.ts#fragment", root)).toBe(false);
  });
});
