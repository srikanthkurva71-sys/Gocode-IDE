import { describe, expect, it } from "vitest";
import { parseGitHunks } from "./gitHunks";

const combinedDiff = `--- Unstaged changes ---
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
@@ -10,2 +10,2 @@
-oldCall();
+newCall();
--- Staged changes ---
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 Intro
+More details
`;

describe("parseGitHunks", () => {
  it("splits multiple unstaged hunks into independently applicable patches", () => {
    const hunks = parseGitHunks(combinedDiff).filter(hunk => hunk.kind === "unstaged");
    expect(hunks).toHaveLength(2);
    expect(hunks[0].path).toBe("src/a.ts");
    expect(hunks[0].patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(hunks[0].patch).toContain("@@ -1,3 +1,3 @@");
    expect(hunks[0].patch).not.toContain("@@ -10,2 +10,2 @@");
    expect(hunks[1].patch).toContain("@@ -10,2 +10,2 @@");
  });

  it("parses staged hunks separately from unstaged hunks", () => {
    const hunks = parseGitHunks(combinedDiff);
    expect(hunks).toHaveLength(3);
    expect(hunks[2].kind).toBe("staged");
    expect(hunks[2].path).toBe("README.md");
    expect(hunks[2].patch).toContain("+More details");
  });

  it("ignores clean files and binary-only patches without hunks", () => {
    expect(parseGitHunks("--- Unstaged changes ---\ndiff --git a/image.png b/image.png\nBinary files differ\n--- Staged changes ---")).toEqual([]);
  });

  it("returns no hunks for malformed or empty diff output", () => {
    expect(parseGitHunks("")).toEqual([]);
    expect(parseGitHunks("not a git diff")).toEqual([]);
  });
});
