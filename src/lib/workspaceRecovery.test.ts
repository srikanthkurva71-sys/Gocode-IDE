import { describe, expect, it } from "vitest";
import {
  createWorkspaceRecoverySnapshot,
  parseWorkspaceRecoverySnapshot,
  MAX_RECOVERY_FILES,
  MAX_RECOVERY_FILE_CHARS,
} from "./workspaceRecovery";

describe("workspace crash recovery snapshots", () => {
  it("round-trips bounded dirty project buffers with their disk baselines", () => {
    const snapshot = createWorkspaceRecoverySnapshot("C:/Projects/demo", {
      "src/main.ts": { content: "unsaved", baseline: "saved" },
    }, 1234);
    expect(snapshot).not.toBeNull();
    expect(parseWorkspaceRecoverySnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("does not create snapshots for clean buffers or empty workspaces", () => {
    expect(createWorkspaceRecoverySnapshot("/project", {
      "clean.txt": { content: "same", baseline: "same" },
    })).toBeNull();
    expect(createWorkspaceRecoverySnapshot("/project", {})).toBeNull();
  });

  it("rejects malformed, unsupported, oversized and unsafe snapshots", () => {
    expect(parseWorkspaceRecoverySnapshot(null)).toBeNull();
    expect(parseWorkspaceRecoverySnapshot("not json")).toBeNull();
    expect(parseWorkspaceRecoverySnapshot("x".repeat(5 * 1024 * 1024 + 1))).toBeNull();
    expect(parseWorkspaceRecoverySnapshot(JSON.stringify({
      version: 2, projectRoot: "/project", savedAt: 1,
      files: { "safe.txt": { content: "new", baseline: "old" } },
    }))).toBeNull();
    expect(createWorkspaceRecoverySnapshot("/project", {
      "../outside.txt": { content: "new", baseline: "old" },
      "CON.txt": { content: "new", baseline: "old" },
    })).toBeNull();
  });

  it("enforces per-file and file-count limits", () => {
    expect(createWorkspaceRecoverySnapshot("/project", {
      "large.txt": { content: "x".repeat(MAX_RECOVERY_FILE_CHARS + 1), baseline: "" },
    })).toBeNull();
    const files: Record<string, { content: string; baseline: string }> = {};
    for (let index = 0; index < MAX_RECOVERY_FILES + 1; index += 1) {
      files[`file-${index}.txt`] = { content: "new", baseline: "old" };
    }
    expect(Object.keys(createWorkspaceRecoverySnapshot("/project", files)!.files)).toHaveLength(MAX_RECOVERY_FILES);
  });
});
