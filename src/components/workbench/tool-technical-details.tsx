import type { AgentActivity } from "./agent-thread-projection";

type ToolActivity = Extract<AgentActivity, { type: "tool" }>;

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法显示安全数据";
  }
};

function RawValue({ label, value }: { label: string; value: unknown }) {
  return <div className="agent-tool-raw-section"><strong>{label}</strong><pre>{safeJson(value)}</pre></div>;
}

export function ToolTechnicalDetails({ activity }: { activity: ToolActivity }) {
  const hasInput = activity.input !== undefined;
  const hasOutput = activity.output !== undefined;
  const hasError = activity.errorDetails !== undefined || activity.error !== undefined;
  if (!hasInput && !hasOutput && !hasError) return null;
  return <details className="agent-tool-details">
    <summary>技术详情</summary>
    <div className="agent-tool-detail-content">
      <small><code>{activity.name}</code></small>
      <details className="agent-tool-raw-details">
        <summary>查看原始安全数据</summary>
        {hasInput && <RawValue label="输入" value={activity.input} />}
        {hasOutput && <RawValue label="输出" value={activity.output} />}
        {hasError && <RawValue label="错误" value={activity.errorDetails ?? activity.error} />}
      </details>
    </div>
  </details>;
}
