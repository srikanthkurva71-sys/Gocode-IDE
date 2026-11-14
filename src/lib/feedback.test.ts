import { describe, expect, it } from "vitest";
import { createFeedbackIssueUrl, FEEDBACK_REPOSITORY } from "./feedback";

describe("createFeedbackIssueUrl", () => {
  it("creates an editable issue with app context", () => {
    const url = new URL(createFeedbackIssueUrl({ category: "Bug report", message: "Save failed.", platform: "Windows desktop" }));
    expect(url.pathname).toBe(`/${FEEDBACK_REPOSITORY}/issues/new`);
    expect(url.searchParams.get("title")).toContain("[Bug]");
    expect(url.searchParams.get("body")).toContain("Save failed.");
    expect(url.searchParams.get("body")).toContain("Version: 0.1.0");
    expect(url.searchParams.get("body")).toContain("Platform: Windows desktop");
  });
  it("rejects empty and oversized feedback", () => {
    expect(() => createFeedbackIssueUrl({ category: "General feedback", message: " ", platform: "Browser preview" })).toThrow("cannot be empty");
    expect(() => createFeedbackIssueUrl({ category: "General feedback", message: "x".repeat(5001), platform: "Browser preview" })).toThrow("5,000 characters");
  });
  it("encodes special characters", () => {
    const url = new URL(createFeedbackIssueUrl({ category: "Feature request", message: "Rust & search?", platform: "Browser preview" }));
    expect(url.searchParams.get("body")).toContain("Rust & search?");
  });
});
