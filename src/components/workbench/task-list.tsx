import { FileText, Plus } from "lucide-react";
import type { TaskSummary } from "@/modules/tasks/domain";

interface TaskListProps {
  tasks: readonly TaskSummary[];
  activeTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onCreateTask: () => void;
  heading?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  loading?: boolean;
}

function formatTaskTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ready: "就绪",
  running: "运行中",
  review: "待复核",
  completed: "已完成",
  failed: "失败",
  archived: "已归档",
};

export function TaskList({ tasks, activeTaskId, onSelectTask, onCreateTask, heading = true, onLoadMore, hasMore = false, loadingMore = false, loading = false }: TaskListProps) {
  return (
    <section className="task-list" aria-label="任务列表">
      {heading && (
        <div className="task-list-heading">
          <div>
            <span className="eyebrow">历史</span>
            <h2>任务会话</h2>
          </div>
          <button className="task-new" type="button" onClick={onCreateTask}>
            <Plus size={14} />
            新任务
          </button>
        </div>
      )}
      {loading ? (
        <p className="task-list-empty" aria-live="polite">正在加载任务…</p>
      ) : tasks.length === 0 ? (
        <p className="task-list-empty">还没有任务。上传一份文档会创建新会话。</p>
      ) : (
        <ol className="task-list-items">
          {tasks.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === activeTaskId ? "active" : ""}
                onClick={() => onSelectTask(item.id)}
              >
                <FileText size={15} />
                <span>
                  <strong>{item.fileName}</strong>
                  <small><i className={`task-status-dot ${item.status}`} aria-hidden="true" />{STATUS_LABEL[item.status] ?? item.status} · {formatTaskTime(item.updatedAt)}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {onLoadMore && hasMore && <button className="task-load-more" type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "正在加载…" : "加载更多任务"}</button>}
    </section>
  );
}
