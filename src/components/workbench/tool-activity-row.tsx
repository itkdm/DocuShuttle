import type { ReactNode } from "react";

export function ToolActivityRow({ name, detail, icon, className }: { name: string; detail: string; icon: ReactNode; className?: string }) {
  return <span className={`agent-tool-item ${className ?? ""}`}>
    <span className="agent-tool-icon">{icon}</span>
    <span className="agent-tool-content">
      <span className="agent-tool-heading"><strong>{name}</strong><small>{detail}</small></span>
    </span>
  </span>;
}
