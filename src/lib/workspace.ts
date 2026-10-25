export type WorkspaceMatch = [name: string, body: string];

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function isValidRelativeFileName(input: string): boolean {
  if (!input || !input.trim() || input !== input.trim()) return false;
  const name = input;
  if (/^[a-zA-Z]:/.test(name)) return false;

  return !name.split("/").some(part => {
    const windowsComparable = part.replace(/[. ]+$/, "");
    return !part ||
      part === "." ||
      part === ".." ||
      part.includes("\\") ||
      part.includes(":") ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      WINDOWS_RESERVED_NAMES.test(windowsComparable);
  });
}

export function findWorkspaceMatches(
  files: Record<string, string>,
  query: string,
): WorkspaceMatch[] {
  const needle = query.toLowerCase();
  return Object.entries(files).filter(([name, body]) =>
    (name + "\n" + body).toLowerCase().includes(needle)
  );
}

export function formatTaskOutput(success: boolean, command: string, output: string): string {
  return (success ? "SUCCESS: " : "FAILED: ") + command + "\n\n" + output;
}

export function sanitizeWorkspaceFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, string> = {};
  for (const [name, body] of Object.entries(value)) {
    if (typeof body === "string" && isValidRelativeFileName(name)) safe[name] = body;
  }
  return safe;
}
