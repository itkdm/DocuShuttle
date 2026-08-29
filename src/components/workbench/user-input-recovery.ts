import type { AgentRuntimePendingInteraction } from "@/modules/agent/domain/model";

export function shouldPreserveSubmittedUserReply(
  originalInteractionId: string | undefined,
  recoveredPendingInteraction: AgentRuntimePendingInteraction | undefined,
) {
  return Boolean(
    originalInteractionId &&
      recoveredPendingInteraction?.type === "user_input" &&
      recoveredPendingInteraction.interactionId === originalInteractionId,
  );
}
