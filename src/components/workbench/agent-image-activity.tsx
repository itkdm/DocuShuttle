import Image from "next/image";
import { AlertCircle, Check, Image as ImageIcon, LoaderCircle, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentActivity } from "./agent-thread-projection";
import { ToolActivityDisclosure } from "./tool-activity-disclosure";
import { ToolActivityRow } from "./tool-activity-row";

type RecordValue = Record<string, unknown>;

export const asRecord = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const stringField = (record: RecordValue | undefined, key: string) => typeof record?.[key] === "string" ? record[key] as string : undefined;
const toolLabel = (name: string) => ({ inspect_image: "分析图片", generate_image: "生成图片", replace_document_image: "替换文档图片", capture_document_view: "查看文档截图" }[name] ?? name);

export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => { if (!lightboxOpen) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxOpen(false); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [lightboxOpen]);
  return <><button type="button" className={`agent-image-preview ${state}`} aria-label={state === "error" ? "图片预览暂不可用" : `${alt}，放大查看`} onClick={() => state === "loaded" && setLightboxOpen(true)} disabled={state !== "loaded"}>
    {state === "loading" && <span>加载图片…</span>}
    {state === "error" ? <span>图片预览暂不可用</span> : <Image src={src} alt={alt} fill unoptimized loading="lazy" onLoad={() => setState("loaded")} onError={() => setState("error")} />}
  </button>{lightboxOpen && typeof document !== "undefined" && createPortal(<div className="agent-image-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={() => setLightboxOpen(false)}><button type="button" aria-label="关闭图片预览" onClick={() => setLightboxOpen(false)}>×</button><Image src={src} alt={alt} width={1600} height={1200} unoptimized onClick={(event) => event.stopPropagation()} /></div>, document.body)}</>;
}

function ActivityIcon({ activity }: { activity: Extract<AgentActivity, { type: "tool" }> }) {
  if (activity.state === "running") return <LoaderCircle size={13} className="event-spinner" />;
  if (activity.state === "failed") return <AlertCircle size={13} />;
  if (activity.state === "approval") return <Shield size={13} />;
  return <Check size={13} />;
}

export function AgentImageActivity({ activity, taskId, onApproval, deciding }: { activity: Extract<AgentActivity, { type: "tool" }>; taskId?: string; onApproval?: (choice: "approved" | "rejected", callId?: string) => void | Promise<void>; deciding: boolean }) {
  const input = asRecord(activity.input);
  const output = asRecord(activity.output);
  const isInspect = activity.name === "inspect_image";
  const isGenerate = activity.name === "generate_image";
  const isReplace = activity.name === "replace_document_image";
  const isCapture = activity.name === "capture_document_view";
  const assetId = stringField(output, "assetId") ?? stringField(input, "assetId");
  const nodeId = stringField(output, "nodeId") ?? stringField(input, "targetNodeId") ?? stringField(input, "nodeId");
  const revision = stringField(output, "revision") ?? stringField(input, "expectedRevision") ?? stringField(output, "previousRevision");
  const source = stringField(output, "source") ?? stringField(input, "source");
  const imageUrl = taskId && assetId ? `/api/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(assetId)}` : undefined;
  const workingUrl = taskId && nodeId && (source === "working-document" || isReplace) ? `/api/tasks/${encodeURIComponent(taskId)}/document/images/${encodeURIComponent(nodeId)}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}` : undefined;
  const detail = activity.state === "approval" ? "等待你的确认" : activity.state === "failed" ? activity.error ?? "未完成" : activity.state === "running" ? "处理中" : "已完成";
  const hasRichBody = (isInspect && activity.state === "completed" && Boolean(imageUrl || workingUrl))
    || (isGenerate && (activity.state === "running" || (activity.state === "completed" && Boolean(imageUrl))))
    || (isReplace && activity.state === "approval" && Boolean(workingUrl || imageUrl || onApproval))
    || (isReplace && activity.state === "completed" && Boolean(imageUrl))
    || (isCapture && activity.state === "completed" && Boolean(imageUrl));
  const row = <ToolActivityRow name={toolLabel(activity.name)} detail={`${detail}${activity.durationMs !== undefined ? ` · ${activity.durationMs}ms` : ""}`} icon={<ActivityIcon activity={activity} />} className={`agent-image-activity ${activity.state}`} />;
  if (!hasRichBody) return row;
  const content = <>
      {isInspect && activity.state === "completed" && <div className="agent-image-summary">{imageUrl && <ImagePreview src={imageUrl} alt="已分析的生成图片" />}{!imageUrl && workingUrl && <ImagePreview src={workingUrl} alt="已分析的文档图片" />}</div>}
      {isGenerate && activity.state === "running" && <p className="agent-image-muted"><ImageIcon size={13} />正在生成图片…</p>}
      {isGenerate && activity.state === "completed" && <div className="agent-image-summary">{imageUrl && <ImagePreview src={imageUrl} alt="生成结果" />}</div>}
      {isCapture && activity.state === "completed" && <div className="agent-image-summary">{imageUrl && <ImagePreview src={imageUrl} alt="文档页面截图" />}</div>}
      {isReplace && <div className="agent-image-summary">{activity.state === "approval" ? <div className="agent-image-compare">{workingUrl && <div><small>当前图片</small><ImagePreview src={workingUrl} alt="当前文档图片" /></div>}{imageUrl && <><span className="agent-image-compare-separator" aria-hidden="true">↓</span><div><small>替换为</small><ImagePreview src={imageUrl} alt="生成替换图片" /></div></>}</div> : imageUrl && <ImagePreview src={imageUrl} alt="最终替换图片" />}</div>}
      {isReplace && activity.state === "approval" && onApproval && <div className="agent-approval-actions"><button className="primary-small" onClick={() => void onApproval("approved", activity.callId)} disabled={deciding}>批准并替换</button><button onClick={() => void onApproval("rejected", activity.callId)} disabled={deciding}>拒绝</button></div>}
  </>;
  return <ToolActivityDisclosure state={activity.state} autoOpenOnComplete={isGenerate} initiallyOpen={activity.state === "approval"} summary={row}>{content}</ToolActivityDisclosure>;
}
