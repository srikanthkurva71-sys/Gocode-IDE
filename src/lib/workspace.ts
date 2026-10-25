export type WorkspaceMatch = [name: string, body: string];

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function isValidRelativeFileName(input: string): boolean {
  const name = input.trim();
  if (!name || /^[a-zA-Z]:/.test(name)) return false;

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
