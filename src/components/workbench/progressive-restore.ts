export type ProgressiveProjection<T> = {
  load: () => Promise<T>;
  onSuccess: (value: T) => void;
  onFailure?: (error: unknown) => void;
  onSettled?: () => void;
};

export const initialConversationLoading = (routeTaskId?: string) => Boolean(routeTaskId);

/** Start one task projection without making it wait for sibling projections. */
export function startProgressiveProjection<T>(projection: ProgressiveProjection<T>, isCurrent: () => boolean) {
  void projection.load()
    .then((value) => { if (isCurrent()) projection.onSuccess(value); })
    .catch((error: unknown) => { if (isCurrent()) projection.onFailure?.(error); })
    .finally(() => { if (isCurrent()) projection.onSettled?.(); });
}
