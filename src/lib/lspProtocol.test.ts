import { describe, expect, it } from "vitest";
import { decodeLspFrames, encodeLspFrame, MAX_LSP_MESSAGE_BYTES } from "./lspProtocol";

describe("LSP framing helpers", () => {
  it("encodes Content-Length as UTF-8 bytes, including non-ASCII text", () => {
    const frame = encodeLspFrame({ jsonrpc: "2.0", method: "test", params: { text: "héllo 🧩" } });
    const [header, body] = frame.split("\r\n\r\n");
    expect(header).toBe(`Content-Length: ${new TextEncoder().encode(body).byteLength}`);
    expect(JSON.parse(body).params.text).toBe("héllo 🧩");
  });

  it("decodes a complete frame", () => {
    const frame = encodeLspFrame({ jsonrpc: "2.0", id: 1, result: null });
    expect(decodeLspFrames(frame)).toEqual({ ok: true, messages: ['{"jsonrpc":"2.0","id":1,"result":null}'], remainder: "" });
  });

  it("keeps incomplete headers and bodies for the next chunk", () => {
    const frame = encodeLspFrame({ jsonrpc: "2.0", method: "initialized" });
    const splitAt = frame.indexOf("\r\n\r\n") + 8;
    const first = decodeLspFrames(frame.slice(0, splitAt));
    expect(first.ok).toBe(true);
    if (first.ok) {
      const second = decodeLspFrames(first.remainder + frame.slice(splitAt));
      expect(second.ok).toBe(true);
      if (second.ok) expect(JSON.parse(second.messages[0]).method).toBe("initialized");
    }
  });

  it("decodes multiple concatenated frames", () => {
    const result = decodeLspFrames(
      encodeLspFrame({ jsonrpc: "2.0", id: 1 }) +
      encodeLspFrame({ jsonrpc: "2.0", id: 2 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messages.map(message => JSON.parse(message).id)).toEqual([1, 2]);
  });

  it("rejects missing or duplicate Content-Length headers", () => {
    expect(decodeLspFrames("X-Test: yes\r\n\r\n{}").ok).toBe(false);
    expect(decodeLspFrames("Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}").ok).toBe(false);
  });

  it("rejects malformed, unsafe, and oversized lengths", () => {
    expect(decodeLspFrames("Content-Length: nope\r\n\r\n{}").ok).toBe(false);
    expect(decodeLspFrames(`Content-Length: ${MAX_LSP_MESSAGE_BYTES + 1}\r\n\r\n`).ok).toBe(false);
    expect(() => encodeLspFrame("x".repeat(MAX_LSP_MESSAGE_BYTES + 1))).toThrow();
  });

  it("bounds an incomplete header", () => {
    expect(decodeLspFrames("x".repeat(1025)).ok).toBe(false);
  });
});
