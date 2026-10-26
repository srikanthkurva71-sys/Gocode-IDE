export type DebugThread = { id: number; name: string };
export type DebugStackFrame = { id: number; name: string; line: number; column: number; sourcePath: string | null };
export type DebugScope = { name: string; variablesReference: number; expensive: boolean };
export type DebugVariable = { name: string; value: string; type: string | null; variablesReference: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function listFromBody(message: unknown, key: string): unknown[] {
  const outer = record(message);
  const body = record(outer?.body);
  return Array.isArray(body?.[key]) ? body[key] as unknown[] : [];
}

export function normalizeDebugThreads(message: unknown): DebugThread[] {
  return listFromBody(message, "threads").flatMap(value => {
    const item = record(value);
    return item && Number.isInteger(item.id) && typeof item.name === "string"
      ? [{ id: item.id as number, name: item.name.slice(0, 300) }]
      : [];
  }).slice(0, 500);
}

export function normalizeDebugStackFrames(message: unknown): DebugStackFrame[] {
  return listFromBody(message, "stackFrames").flatMap(value => {
    const item = record(value);
    if (!item || !Number.isInteger(item.id) || typeof item.name !== "string") return [];
    const source = record(item.source);
    return [{
      id: item.id as number,
      name: item.name.slice(0, 300),
      line: Number.isInteger(item.line) && (item.line as number) > 0 ? item.line as number : 1,
      column: Number.isInteger(item.column) && (item.column as number) > 0 ? item.column as number : 1,
      sourcePath: typeof source?.path === "string" ? source.path.slice(0, 4096) : null,
    }];
  }).slice(0, 1000);
}

export function normalizeDebugScopes(message: unknown): DebugScope[] {
  return listFromBody(message, "scopes").flatMap(value => {
    const item = record(value);
    return item && typeof item.name === "string" && Number.isInteger(item.variablesReference) && (item.variablesReference as number) >= 0
      ? [{ name: item.name.slice(0, 200), variablesReference: item.variablesReference as number, expensive: item.expensive === true }]
      : [];
  }).slice(0, 200);
}

export function normalizeDebugVariables(message: unknown): DebugVariable[] {
  return listFromBody(message, "variables").flatMap(value => {
    const item = record(value);
    if (!item || typeof item.name !== "string") return [];
    return [{
      name: item.name.slice(0, 300),
      value: typeof item.value === "string" ? item.value.slice(0, 4000) : String(item.value ?? ""),
      type: typeof item.type === "string" ? item.type.slice(0, 200) : null,
      variablesReference: Number.isInteger(item.variablesReference) && (item.variablesReference as number) >= 0 ? item.variablesReference as number : 0,
    }];
  }).slice(0, 2000);
}
