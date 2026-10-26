/** Small, bounded JSON-RPC/LSP framing helpers. These do not launch a language server. */
export const MAX_LSP_MESSAGE_BYTES = 8 * 1024 * 1024;

export type LspFrameResult =
  | { ok: true; messages: string[]; remainder: string }
  | { ok: false; error: string; remainder: string };

/** Encode a JSON-RPC payload using LSP's Content-Length byte framing. */
export function encodeLspFrame(payload: unknown): string {
  const body = JSON.stringify(payload);
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > MAX_LSP_MESSAGE_BYTES) {
    throw new Error(`LSP message exceeds ${MAX_LSP_MESSAGE_BYTES} bytes.`);
  }
  return `Content-Length: ${byteLength}\r\n\r\n${body}`;
}

/**
 * Decode as many complete LSP frames as possible from a text chunk.
 * Keep the returned remainder for the next chunk. The transport layer must
 * only call this with decoded UTF-8 text and should cap its accumulated buffer.
 */
export function decodeLspFrames(input: string): LspFrameResult {
  const messages: string[] = [];
  let buffer = input;

  while (buffer.length) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) {
      if (new TextEncoder().encode(buffer).byteLength > 1024) {
        return { ok: false, error: "LSP header exceeded 1024 bytes.", remainder: "" };
      }
      return { ok: true, messages, remainder: buffer };
    }

    const header = buffer.slice(0, separator);
    const lengthHeaders = header.split("\r\n").filter(line => /^content-length\s*:/i.test(line));
    if (lengthHeaders.length !== 1) {
      return { ok: false, error: "LSP frame must contain exactly one Content-Length header.", remainder: "" };
    }

    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(lengthHeaders[0]);
    if (!match) return { ok: false, error: "Invalid LSP Content-Length header.", remainder: "" };

    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_MESSAGE_BYTES) {
      return { ok: false, error: "LSP message length is invalid or exceeds the 8 MB limit.", remainder: "" };
    }

    const bodyStart = separator + 4;
    // Text strings count UTF-16 code units, but Content-Length counts UTF-8 bytes.
    // Walk code points until the exact UTF-8 byte length is reached.
    let bodyEnd = bodyStart;
    let bytes = 0;
    while (bodyEnd < buffer.length && bytes < length) {
      const point = buffer.codePointAt(bodyEnd);
      if (point === undefined) break;
      const character = String.fromCodePoint(point);
      bytes += new TextEncoder().encode(character).byteLength;
      bodyEnd += character.length;
    }
    if (bytes < length) return { ok: true, messages, remainder: buffer };
    if (bytes !== length) return { ok: false, error: "LSP body ended inside a UTF-8 character.", remainder: "" };

    messages.push(buffer.slice(bodyStart, bodyEnd));
    buffer = buffer.slice(bodyEnd);
  }

  return { ok: true, messages, remainder: "" };
}
