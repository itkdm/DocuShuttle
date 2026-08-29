import { useEffect, useRef, useState, type ReactNode } from "react";

export function ToolActivityDisclosure({
  initiallyOpen = false,
  autoOpenOnComplete = false,
  state,
  summary,
  children,
}: {
  initiallyOpen?: boolean;
  autoOpenOnComplete?: boolean;
  state: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const previousState = useRef(state);
  useEffect(() => {
    if (autoOpenOnComplete && previousState.current !== "completed" && state === "completed") setOpen(true);
    previousState.current = state;
  }, [autoOpenOnComplete, state]);
  return <details className="agent-tool-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="agent-tool-summary">{summary}</summary>
    <div className="agent-tool-body">{children}</div>
  </details>;
}
