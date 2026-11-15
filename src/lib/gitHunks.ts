export type GitHunkKind = "unstaged" | "staged";

export interface GitHunk {
  id: string;
  path: string;
  kind: GitHunkKind;
  header: string;
  patch: string;
  summary: string;
}

function splitGitFiles(section: string): string[] {
  const lines = section.split("\n");
  const files: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) files.push(current);
  return files.map(lines => lines.join("\n"));
}

function displayPath(header: string): string {
  const added = header.match(/^\+\+\+ b\/(.+)$/m);
  const removed = header.match(/^--- a\/(.+)$/m);
  const raw = added?.[1] ?? removed?.[1] ?? "unknown file";
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

/** Parse Git's ordinary unified diff into independently applicable hunk patches. */
export function parseGitHunks(diff: string): GitHunk[] {
  const sections = [
    { marker: "--- Unstaged changes ---", kind: "unstaged" as const },
    { marker: "--- Staged changes ---", kind: "staged" as const },
  ];
  const result: GitHunk[] = [];
  for (const section of sections) {
    const start = diff.indexOf(section.marker);
    if (start < 0) continue;
    const bodyStart = start + section.marker.length;
    const nextMarker = sections
      .map(item => diff.indexOf(item.marker, bodyStart))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0];
    const body = diff.slice(bodyStart, nextMarker ?? diff.length).trim();
    for (const filePatch of splitGitFiles(body)) {
      const lines = filePatch.split("\n");
      const hunkStarts: number[] = [];
      lines.forEach((line, index) => { if (line.startsWith("@@ ")) hunkStarts.push(index); });
      if (!hunkStarts.length) continue;
      const header = lines.slice(0, hunkStarts[0]).join("\n");
      const path = displayPath(header);
      hunkStarts.forEach((lineIndex, hunkIndex) => {
        const end = hunkStarts[hunkIndex + 1] ?? lines.length;
        const hunkLines = lines.slice(lineIndex, end);
        const marker = hunkLines[0];
        const summary = marker.replace(/^@@\s+/, "").replace(/\s+@@.*$/, "");
        const patch = header + "\n" + hunkLines.join("\n") + "\n";
        result.push({
          id: section.kind + ":" + path + ":" + hunkIndex + ":" + marker,
          path,
          kind: section.kind,
          header,
          patch,
          summary,
        });
      });
    }
  }
  return result;
}
