import Image from "next/image";
import { AlertCircle, Check, Image as ImageIcon, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentActivity } from "./agent-thread-projection";
import { ToolActivityDisclosure } from "./tool-activity-disclosure";

type RecordValue = Record<string, unknown>;

export const asRecord = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const stringField = (record: RecordValue | undefined, key: string) => typeof record?.[key] === "string" ? record[key] as string : undefined;
const numberField = (record: RecordValue | undefined, key: string) => typeof record?.[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
const arrayField = (record: RecordValue | undefined, key: string) => Array.isArray(record?.[key]) ? record[key] as unknown[] : [];
const safeJson = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return "无法显示工具详情"; } };

const purposeLabel = (purpose?: string) => ({ create: "已生成图片", similar: "已生成 · 保持参考图片风格", edit: "已生成 · 按参考图片编辑" }[purpose ?? ""] ?? "已生成图片");
const toolLabel = (name: string) => ({ inspect_image: "分析图片", generate_image: "生成图片", replace_document_image: "替换文档图片" }[name] ?? name);

export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => { if (!lightboxOpen) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxOpen(false); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [lightboxOpen]);
  return <><button type="button" className={`agent-image-preview ${state}`} aria-label={state === "error" ? "图片预览暂不可用" : `${alt}，放大查看`} onClick={() => state === "loaded" && setLightboxOpen(true)} disabled={state !== "loaded"}>
    {state === "loading" && <span>加载图片…</span>}
    {state === "error" ? <span>图片预览暂不可用</span> : <Image src={src} alt={alt} fill unoptimized loading="lazy" onLoad={() => setState("loaded")} onError={() => setState("error")} />}
  </button>{lightboxOpen && typeof document !== "undefined" && createPortal(<div className="agent-image-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={() => setLightboxOpen(false)}><button type="button" aria-label="关闭图片预览" onClick={() => setLightboxOpen(false)}>×</button><Image src={src} alt={alt} width={1600} height={1200} unoptimized onClick={(event) => event.stopPropagation()} /></div>, document.body)}</>;
}

function ToolDetails({ activity }: { activity: Extract<AgentActivity, { type: "tool" }> }) {
  if (activity.input === undefined && activity.output === undefined && !activity.error) return null;
  return <details className="agent-tool-details"><summary>工具详情</summary><div className="agent-tool-detail-content"><small><code>{activity.name}</code></small><pre>{safeJson(activity.errorDetails ?? activity.error ?? activity.output ?? activity.input)}</pre></div></details>;
}

function ActivityIcon({ activity }: { activity: Extract<AgentActivity, { type: "tool" }> }) {
  if (activity.state === "running") return <LoaderCircle size={13} className="event-spinner" />;
  if (activity.state === "failed") return <AlertCircle size={13} />;
  if (activity.state === "approval") return <Shield size={13} />;
  return <Check size={13} />;
}

export function AgentImageActivity({ activity, taskId, onApproval, deciding }: { activity: Extract<AgentActivity, { type: "tool" }>; taskId?: string; onApproval?: (choice: "approved" | "rejected") => void | Promise<void>; deciding: boolean }) {
  const input = asRecord(activity.input);
  const output = asRecord(activity.output);
  const analysis = asRecord(output?.analysis);
  const isInspect = activity.name === "inspect_image";
  const isGenerate = activity.name === "generate_image";
  const isReplace = activity.name === "replace_document_image";
  const assetId = stringField(output, "assetId") ?? stringField(input, "assetId");
  const nodeId = stringField(output, "nodeId") ?? stringField(input, "targetNodeId") ?? stringField(input, "nodeId");
  const revision = stringField(output, "revision") ?? stringField(input, "expectedRevision") ?? stringField(output, "previousRevision");
  const source = stringField(output, "source") ?? stringField(input, "source");
  const imageUrl = taskId && assetId ? `/api/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(assetId)}` : undefined;
  const workingUrl = taskId && nodeId && (source === "working-document" || isReplace) ? `/api/tasks/${encodeURIComponent(taskId)}/document/images/${encodeURIComponent(nodeId)}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}` : undefined;
  const detail = activity.state === "approval" ? "等待你的确认" : activity.state === "failed" ? activity.error ?? "未完成" : activity.state === "running" ? "处理中" : "已完成";
  const visibleText = arrayField(analysis, "visibleText").filter((item): item is string => typeof item === "string").slice(0, 3);
  const referenceCount = numberField(output, "referenceCount") ?? arrayField(input, "references").length;
  const summary = stringField(analysis, "summary");
  const type = stringField(analysis, "type");
  const style = stringField(analysis, "style");
  return <ToolActivityDisclosure state={activity.state} autoOpenOnComplete={isGenerate} initiallyOpen={activity.state === "approval"} summary={<><span className={`agent-tool-item agent-image-activity ${activity.state}`}><span className="agent-tool-icon"><ActivityIcon activity={activity} /></span><span className="agent-tool-content"><span className="agent-tool-heading"><strong>{toolLabel(activity.name)}</strong><small>{detail}{activity.durationMs !== undefined && ` · ${activity.durationMs}ms`}</small></span></span></span></>}>
      {isInspect && activity.state === "completed" && <div className="agent-image-summary">{summary && <p>{summary}</p>}{(type || style) && <small>{[type, style].filter(Boolean).join(" · ")}</small>}{visibleText.length > 0 && <ul>{visibleText.map((text) => <li key={text}>{text}</li>)}</ul>}{imageUrl && <ImagePreview src={imageUrl} alt="已分析的生成图片" />}{!imageUrl && workingUrl && <ImagePreview src={workingUrl} alt="已分析的文档图片" />}</div>}
      {isGenerate && activity.state === "running" && <p className="agent-image-muted"><ImageIcon size={13} />正在生成图片…</p>}
      {isGenerate && activity.state === "completed" && <div className="agent-image-summary">{imageUrl && <ImagePreview src={imageUrl} alt="生成结果" />}<p>{purposeLabel(stringField(output, "purpose"))}{referenceCount > 0 && ` · 参考 ${referenceCount} 张图片`}</p></div>}
      {isReplace && <div className="agent-image-summary">{activity.state === "approval" && <p>确认后会把当前图片替换为生成结果。</p>}{activity.state === "approval" ? <div className="agent-image-compare">{workingUrl && <div><small>当前图片</small><ImagePreview src={workingUrl} alt="当前文档图片" /></div>}{imageUrl && <div><small>生成图片</small><ImagePreview src={imageUrl} alt="生成替换图片" /></div>}</div> : imageUrl && <ImagePreview src={imageUrl} alt="最终替换图片" />}{activity.state === "completed" && <p>已写入当前 Word 文档</p>}</div>}
      {isReplace && activity.state === "approval" && onApproval && <div className="agent-approval-actions"><button className="primary-small" onClick={() => void onApproval("approved")} disabled={deciding}>批准并执行</button><button onClick={() => void onApproval("rejected")} disabled={deciding}>拒绝</button></div>}
      <ToolDetails activity={activity} />
  </ToolActivityDisclosure>;
}
