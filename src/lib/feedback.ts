export const FEEDBACK_REPOSITORY = "srikanthkurva71-sys/Gocode-IDE";
export const APP_VERSION = "0.1.0";
export type FeedbackCategory = "Bug report" | "Feature request" | "General feedback";

export function createFeedbackIssueUrl(input: {
  category: FeedbackCategory;
  message: string;
  platform: "Windows desktop" | "Browser preview";
}): string {
  const message = input.message.trim();
  if (!message) throw new Error("Feedback message cannot be empty.");
  if (message.length > 5000) throw new Error("Feedback must be 5,000 characters or fewer.");
  const prefix = input.category === "Bug report" ? "[Bug]" : input.category === "Feature request" ? "[Feature]" : "[Feedback]";
  const body = [
    "## Feedback", message, "", "## App details",
    `- Version: ${APP_VERSION}`, `- Platform: ${input.platform}`, "",
    "<!-- Remove private information. Do not attach source code, credentials, tokens, or private project paths. -->",
  ].join("\n");
  const params = new URLSearchParams({ title: `${prefix} Gocode IDE feedback`, body });
  return `https://github.com/${FEEDBACK_REPOSITORY}/issues/new?${params.toString()}`;
}
