export type LanguageFeatureItem = { label: string; detail: string; documentation: string; insertText: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown, limit: number): string {
  if (typeof value === "string") return value.slice(0, limit);
  const record = asRecord(value);
  if (record && typeof record.value === "string") return record.value.slice(0, limit);
  if (Array.isArray(value)) return value.slice(0, 30).map(item => {
    const part = asRecord(item);
    return typeof part?.value === "string" ? part.value : typeof part?.language === "string" ? part.language : "";
  }).filter(Boolean).join("\n").slice(0, limit);
  return "";
}

/** Convert common LSP hover result shapes into bounded, display-safe plain text. */
export function normalizeHoverResult(value: unknown): string {
  const outer = asRecord(value);
  return textValue(outer?.contents, 8000);
}

/** Normalize CompletionItem[] and CompletionList into a bounded display model. */
export function normalizeCompletionResult(value: unknown): LanguageFeatureItem[] {
  const outer = asRecord(value);
  const items = Array.isArray(value) ? value : Array.isArray(outer?.items) ? outer.items : [];
  return items.slice(0, 100).flatMap(raw => {
    const item = asRecord(raw);
    if (!item || typeof item.label !== "string") return [];
    return [{
      label: item.label.slice(0, 300),
      detail: typeof item.detail === "string" ? item.detail.slice(0, 1000) : "",
      documentation: textValue(item.documentation, 2000),
      insertText: typeof item.insertText === "string" ? item.insertText.slice(0, 2000) : item.label.slice(0, 300),
    }];
  });
}


export type DefinitionLocation = { path: string; line: number; column: number };

/**
 * Accept a standard LSP Location or LocationLink and only navigate to a file
 * that is inside the currently opened project. Unsupported/non-file URIs are ignored.
 */
export function normalizeDefinitionLocation(value: unknown, projectRoot: string): DefinitionLocation | null {
  const candidates = Array.isArray(value) ? value : [value];
  const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (!root) return null;

  for (const candidate of candidates.slice(0, 20)) {
    const record = asRecord(candidate);
    if (!record) continue;
    const target = asRecord(record.targetSelectionRange) ?? asRecord(record.targetRange) ?? asRecord(record.range);
    const uri = typeof record.targetUri === "string" ? record.targetUri : record.uri;
    if (typeof uri !== "string" || !target) continue;
    const start = asRecord(target.start);
    if (!start || !Number.isInteger(start.line) || !Number.isInteger(start.character)) continue;

    let path: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:") continue;
      path = decodeURIComponent(parsed.pathname);
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
      if (parsed.hostname && parsed.hostname !== "localhost") path = "//" + parsed.hostname + path;
    } catch {
      continue;
    }
    path = path.replace(/\\/g, "/").replace(/\/$/, "");
    const windowsPath = /^[a-zA-Z]:\//.test(root) || /^[a-zA-Z]:\//.test(path);
    const comparedRoot = windowsPath ? root.toLowerCase() : root;
    const comparedPath = windowsPath ? path.toLowerCase() : path;
    if (!comparedPath.startsWith(comparedRoot + "/")) continue;
    const relative = path.slice(root.length + 1);
    if (!relative || relative.split("/").some(part => !part || part === "." || part === "..")) continue;
    return { path: relative, line: Number(start.line) + 1, column: Number(start.character) + 1 };
  }
  return null;
}
