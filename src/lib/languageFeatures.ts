export type LanguageFeatureItem = { label: string; detail: string; documentation: string };

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
    }];
  });
}
