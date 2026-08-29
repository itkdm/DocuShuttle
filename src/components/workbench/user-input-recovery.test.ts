import { describe, expect, it } from "vitest";

import { shouldPreserveSubmittedUserReply } from "./user-input-recovery";

const originalInteractionId = "interaction-a";

describe("shouldPreserveSubmittedUserReply", () => {
  it("preserves the composer only while the original user interaction is pending", () => {
    expect(shouldPreserveSubmittedUserReply(originalInteractionId, {
      interactionId: originalInteractionId,
      type: "user_input",
      question: "原问题",
    })).toBe(true);
  });

  it("accepts the submitted reply when recovery exposes a new user interaction", () => {
    expect(shouldPreserveSubmittedUserReply(originalInteractionId, {
      interactionId: "interaction-b",
      type: "user_input",
      question: "新问题",
    })).toBe(false);
  });

  it("accepts the submitted reply when recovery exposes an approval", () => {
    expect(shouldPreserveSubmittedUserReply(originalInteractionId, {
      interactionId: "interaction-approval",
      type: "approval",
      callId: "call-1",
      toolName: "apply_text_change",
      input: {},
    })).toBe(false);
  });

  it("accepts the submitted reply when recovery has no pending interaction", () => {
    expect(shouldPreserveSubmittedUserReply(originalInteractionId, undefined)).toBe(false);
  });

  it("does not preserve a reply when the original interaction identity is missing", () => {
    expect(shouldPreserveSubmittedUserReply(undefined, {
      interactionId: originalInteractionId,
      type: "user_input",
      question: "原问题",
    })).toBe(false);
  });
});
