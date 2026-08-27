"use client";

import { ChevronDown, FileCheck2, FileText, ImageIcon, PanelLeftClose, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import type { TaskSummary } from "@/modules/tasks/domain";
import { TaskList } from "./task-list";
import type { UploadAsset } from "./types";

interface OutlinePanelProps {
  assets: UploadAsset[];
  onCollapse: () => void;
  onUpload: (kind: UploadAsset["kind"], file?: File) => void;
  documentReady?: boolean;
  paragraphCount?: number;
  imageCount?: number;
  tableCellCount?: number;
  tasks?: readonly TaskSummary[];
  activeTaskId?: string;
  onSelectTask?: (taskId: string) => void;
  onCreateTask?: () => void;
  onLoadMoreTasks?: () => void;
  hasMoreTasks?: boolean;
  loadingMoreTasks?: boolean;
}

export function OutlinePanel({
  assets,
  onCollapse,
  onUpload,
  documentReady = false,
  paragraphCount = 0,
  imageCount = 0,
  tableCellCount = 0,
  tasks = [],
  activeTaskId,
  onSelectTask,
  onCreateTask,
  onLoadMoreTasks,
  hasMoreTasks = false,
  loadingMoreTasks = false,
}: OutlinePanelProps) {
  const inTask = Boolean(activeTaskId);
  const [open, setOpen] = useState({ taskId: activeTaskId, tasks: !inTask, parse: inTask });
  if (open.taskId !== activeTaskId) {
    setOpen({ taskId: activeTaskId, tasks: !inTask, parse: inTask });
  }
  const tasksOpen = open.tasks;
  const parseOpen = open.parse;
  const getAsset = (kind: UploadAsset["kind"]) => assets.find((item) => item.kind === kind);

  return (
    <aside className="outline-panel" aria-label="工作区">
      <div className="panel-heading">
        <div><span className="eyebrow">工作区</span></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起工作区"><PanelLeftClose size={17} /></button>
      </div>
      <div className="source-stack" aria-label="源文档">
        {(["template", "example"] as const).map((kind) => {
          const asset = getAsset(kind);
          const title = kind === "template" ? "空白模板" : "完成示例";
          return (
            <label className={`source-file ${asset ? "is-ready" : ""}`} key={kind}>
              <input id={`outline-${kind}-docx`} name="docx" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onUpload(kind, event.target.files?.[0])} />
              <span className="source-icon">{asset ? <FileCheck2 size={17} /> : <FileText size={17} />}</span>
              <span className="source-copy"><strong>{title}</strong><small>{asset ? asset.name : "选择 .docx"}</small></span>
              <span className="source-action">{asset ? "替换" : "+"}</span>
            </label>
          );
        })}
      </div>
      {onSelectTask && onCreateTask && (
        <section className={`workspace-section ${tasksOpen ? "is-open" : ""}`} aria-label="任务会话">
          <div className="workspace-section-bar">
            <button type="button" className="workspace-section-toggle" aria-expanded={tasksOpen} onClick={() => setOpen((current) => ({ ...current, tasks: !current.tasks }))}>
              <span>
                <small className="eyebrow">历史</small>
              </span>
              <ChevronDown size={15} className={tasksOpen ? "is-open" : ""} />
            </button>
            <button className="task-new" type="button" onClick={onCreateTask}>
              <Plus size={14} />
              新任务
            </button>
          </div>
          {tasksOpen && (
            <div className="workspace-section-body">
              <TaskList tasks={tasks} activeTaskId={activeTaskId} onSelectTask={onSelectTask} onCreateTask={onCreateTask} heading={false} onLoadMore={onLoadMoreTasks} hasMore={hasMoreTasks} loadingMore={loadingMoreTasks} />
            </div>
          )}
        </section>
      )}
      <section className={`workspace-section ${parseOpen ? "is-open" : ""}`} aria-label="文档解析">
        <button type="button" className="workspace-section-toggle" aria-expanded={parseOpen} onClick={() => setOpen((current) => ({ ...current, parse: !current.parse }))}>
          <span>
            <small className="eyebrow">结构</small>
          </span>
          <ChevronDown size={15} className={parseOpen ? "is-open" : ""} />
        </button>
        {parseOpen && (
          <div className="workspace-section-body">
            <ul className="outline-stats">
              <li>
                <span className="outline-stat-icon"><FileText size={15} /></span>
                <span className="outline-stat-copy"><strong>段落</strong><small>正文与标题</small></span>
                <b>{documentReady ? paragraphCount : "—"}</b>
              </li>
              <li>
                <span className="outline-stat-icon"><Table2 size={15} /></span>
                <span className="outline-stat-copy"><strong>表格</strong><small>单元格</small></span>
                <b>{documentReady ? tableCellCount : "—"}</b>
              </li>
              <li>
                <span className="outline-stat-icon"><ImageIcon size={15} /></span>
                <span className="outline-stat-copy"><strong>图片</strong><small>可替换节点</small></span>
                <b>{documentReady ? imageCount : "—"}</b>
              </li>
            </ul>
          </div>
        )}
      </section>
    </aside>
  );
}
