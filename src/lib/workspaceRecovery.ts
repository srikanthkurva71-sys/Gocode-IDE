export const MAX_RECOVERY_FILES = 25;
export const MAX_RECOVERY_FILE_CHARS = 2_000_000;
export const MAX_RECOVERY_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export interface WorkspaceRecoveryFile {
  content: string;
  baseline: string;
}

export interface WorkspaceRecoverySnapshot {
  version: 1;
  projectRoot: string;
  savedAt: number;
  files: Record<string, WorkspaceRecoveryFile>;
}

function validRelativePath(path: string): boolean {
  if (!path || path !== path.trim() || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split("/").some(part =>
    !part || part === "." || part === ".." || part.includes("\\") ||
    part.includes(":") || part.endsWith(".") || part.endsWith(" ") ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part.replace(/[. ]+$/, ""))
  );
}

export function createWorkspaceRecoverySnapshot(
  projectRoot: string,
  files: Record<string, WorkspaceRecoveryFile>,
  savedAt = Date.now(),
): WorkspaceRecoverySnapshot | null {
  if (!projectRoot || projectRoot.length > 4096 || !Number.isFinite(savedAt)) return null;
  const safeFiles: Record<string, WorkspaceRecoveryFile> = {};
  for (const [path, file] of Object.entries(files)) {
    if (Object.keys(safeFiles).length >= MAX_RECOVERY_FILES) break;
    if (!validRelativePath(path) || !file || typeof file.content !== "string" ||
        typeof file.baseline !== "string" ||
        file.content.length > MAX_RECOVERY_FILE_CHARS ||
        file.baseline.length > MAX_RECOVERY_FILE_CHARS ||
        file.content === file.baseline) continue;
    safeFiles[path] = { content: file.content, baseline: file.baseline };
  }
  if (!Object.keys(safeFiles).length) return null;
  const snapshot: WorkspaceRecoverySnapshot = { version: 1, projectRoot, savedAt, files: safeFiles };
  return JSON.stringify(snapshot).length <= MAX_RECOVERY_SNAPSHOT_BYTES ? snapshot : null;
}

export function parseWorkspaceRecoverySnapshot(raw: string | null): WorkspaceRecoverySnapshot | null {
  if (!raw || raw.length > MAX_RECOVERY_SNAPSHOT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1 || typeof candidate.projectRoot !== "string" ||
        !candidate.projectRoot || candidate.projectRoot.length > 4096 ||
        typeof candidate.savedAt !== "number" || !Number.isFinite(candidate.savedAt) ||
        !candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files)) return null;
    const files: Record<string, WorkspaceRecoveryFile> = {};
    for (const [path, entry] of Object.entries(candidate.files)) {
      if (Object.keys(files).length >= MAX_RECOVERY_FILES) return null;
      if (!validRelativePath(path) || !entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item.content !== "string" || typeof item.baseline !== "string" ||
          item.content.length > MAX_RECOVERY_FILE_CHARS ||
          item.baseline.length > MAX_RECOVERY_FILE_CHARS ||
          item.content === item.baseline) return null;
      files[path] = { content: item.content, baseline: item.baseline };
    }
    if (!Object.keys(files).length) return null;
    return { version: 1, projectRoot: candidate.projectRoot, savedAt: candidate.savedAt, files };
  } catch {
    return null;
  }
}
