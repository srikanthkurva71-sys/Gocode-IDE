import { describe, expect, it } from "vitest";
import { encodeProtocolMessage, normalizeLspDiagnostics, parseProtocolFrames } from "./languageProtocol";

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
    const body = new TextEncoder().encode("{}");
    const frame = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n{}`);
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
