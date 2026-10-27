export const MAX_PROTOCOL_HEADER_BYTES = 8 * 1024;
export const MAX_PROTOCOL_BODY_BYTES = 8 * 1024 * 1024;

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type ProtocolFrameResult = {
  messages: JsonRpcMessage[];
  remainder: Uint8Array;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Encode one LSP/DAP JSON-RPC payload using byte-counted Content-Length framing. */
export function encodeProtocolMessage(message: JsonRpcMessage): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  if (body.length > MAX_PROTOCOL_BODY_BYTES) {
    throw new Error("Protocol message exceeds the 8 MiB limit.");
  }
  return concatBytes(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
}

/**
 * Parse complete Content-Length framed messages from a byte stream.
 * Incomplete headers/bodies remain buffered for the next read.
 */
export function parseProtocolFrames(input: Uint8Array): ProtocolFrameResult {
  const messages: JsonRpcMessage[] = [];
  let buffer = input;
  while (buffer.length) {
    let separator = -1;
    for (let i = 0; i + 3 < buffer.length; i++) {
      if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
        separator = i;
        break;
      }
    }
    if (separator < 0) {
      if (buffer.length > MAX_PROTOCOL_HEADER_BYTES) throw new Error("Protocol header exceeds the 8 KiB limit.");
      break;
    }
    if (separator > MAX_PROTOCOL_HEADER_BYTES) throw new Error("Protocol header exceeds the 8 KiB limit.");
    const header = decoder.decode(buffer.slice(0, separator));
    const lengthHeaders = header.split("\r\n")
      .map(line => /^content-length\s*:\s*(\d+)\s*$/i.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    if (lengthHeaders.length !== 1) throw new Error("Protocol frame must contain exactly one Content-Length header.");
    const length = Number(lengthHeaders[0][1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROTOCOL_BODY_BYTES) {
      throw new Error("Protocol body length is invalid or exceeds the 8 MiB limit.");
    }
    const bodyStart = separator + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(buffer.slice(bodyStart, bodyEnd)));
    } catch {
      throw new Error("Protocol body is not valid UTF-8 JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).jsonrpc !== "2.0") {
      throw new Error("Protocol body must be a JSON-RPC 2.0 object.");
    }
    messages.push(parsed as JsonRpcMessage);
    buffer = buffer.slice(bodyEnd);
  }
  return { messages, remainder: buffer };
}

export type LspPosition = { line: number; character: number };
export type LspDiagnostic = {
  range: { start: LspPosition; end: LspPosition };
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
};

export type EditorMarker = {
  lineNumber: number;
  column: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
};

export function normalizeLspDiagnostics(value: unknown): EditorMarker[] {
  if (!Array.isArray(value)) return [];
  const markers: EditorMarker[] = [];
  for (const item of value.slice(0, 1000)) {
    if (!item || typeof item !== "object") continue;
    const d = item as Partial<LspDiagnostic>;
    const start = d.range?.start;
    const end = d.range?.end;
    if (!start || !end || !Number.isInteger(start.line) || !Number.isInteger(start.character) ||
        !Number.isInteger(end.line) || !Number.isInteger(end.character) || typeof d.message !== "string") continue;
    const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 4 ? "hint" : "info";
    markers.push({
      lineNumber: Math.max(1, start.line + 1),
      column: Math.max(1, start.character + 1),
      endLineNumber: Math.max(1, end.line + 1),
      endColumn: Math.max(1, end.character + 1),
      message: d.message.slice(0, 4000),
      severity,
      ...(typeof d.source === "string" ? { source: d.source.slice(0, 100) } : {}),
    });
  }
  return markers;
}
