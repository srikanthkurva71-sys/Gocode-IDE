export type WorkspaceMatch = [name: string, body: string];

export function isValidRelativeFileName(input: string): boolean {
  const name = input.trim().replace(/^\/+/, "");
  return Boolean(name) &&
    !name.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"));
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
