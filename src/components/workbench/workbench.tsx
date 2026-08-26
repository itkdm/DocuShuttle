"use client";

import { Check, ChevronDown, Cloud, Download, FilePlus2, History, Menu, PanelLeftOpen, PanelRightOpen, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentPanel } from "./agent-panel";
import { DocumentCanvas } from "./document-canvas";
import { OutlinePanel } from "./outline-panel";
import { PaperDuckMark } from "./paperduck-mark";
import { downloadLocalDocument, formatFileSize, readDocxFile } from "./docx-file";
import { persistSourceFile, productionPersistenceConfigured } from "@/modules/uploads/browser-source-upload";
import { emptySourceRegistrationState, isWorkingDocumentUpload, reduceSourceRegistration, type SourceRegistrationState } from "@/modules/uploads/source-role-semantics";
import { advanceBrowserAgentRun, applyBrowserImageCandidate, cancelBrowserAgentRun, createBrowserAgentRun, createBrowserDocumentExport, decideBrowserAgentRun, generateBrowserImageCandidates, loadBrowserAgentRun, loadBrowserDocumentVersions, loadCurrentTaskDocument, restoreBrowserDocumentVersion, reviewBrowserAgentRun, type BrowserImageCandidate } from "@/modules/agent/browser-runtime";
import type { AgentRun } from "@/modules/agent";
import type { AgentStage, DocumentLoadState, ProposalState, UploadAsset, VersionItem } from "./types";

const initialAssets: UploadAsset[] = [];
const initialVersions: VersionItem[] = [
  { id: "pending", label: "等待导入文档", time: "当前", actor: "纸上鸭", current: true },
];
const workspaceResumeKey = "paperduck-workbench-resume-v1";

export function Workbench() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<"none" | "outline" | "agent" | "versions">("none");
  const [proposal, setProposal] = useState<ProposalState>("pending");
  const [stage, setStage] = useState<AgentStage>("awaiting");
  const [assets, setAssets] = useState(initialAssets);
  const [sourceState, setSourceState] = useState<SourceRegistrationState>(emptySourceRegistrationState);
  const [documentLoad, setDocumentLoad] = useState<DocumentLoadState>({ status: "empty" });
  const [versions, setVersions] = useState(initialVersions);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [notice, setNotice] = useState("请选择真实 DOCX；文件只在当前浏览器中读取");
  const [taskId, setTaskId] = useState<string>();
  const [cloudSaved, setCloudSaved] = useState(false);
  const [run, setRun] = useState<AgentRun>();
  const [proposalSummary, setProposalSummary] = useState<string>();
  const [awaitingFinalReview, setAwaitingFinalReview] = useState(false);
  const [currentRevision, setCurrentRevision] = useState<string>();
  const [imageCandidates, setImageCandidates] = useState<BrowserImageCandidate[]>([]);
  const [imageTargetNodeId, setImageTargetNodeId] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  useEffect(() => {
    if (!productionPersistenceConfigured()) return;
    const raw = window.localStorage.getItem(workspaceResumeKey);
    if (!raw) return;
    let saved: { taskId?: string; runId?: string; fileName?: string };
    try { saved = JSON.parse(raw) as typeof saved; } catch { window.localStorage.removeItem(workspaceResumeKey); return; }
    if (!saved.taskId) return;
    void (async () => {
      try {
        const fileName = saved.fileName ?? "paperduck.docx";
        const document = await loadCurrentTaskDocument(saved.taskId!, fileName);
        setTaskId(saved.taskId); setCloudSaved(true);
        setDocumentLoad({ status: "ready", document: { file: document.file, bytes: document.bytes } }); setCurrentRevision(document.version.revision);
        await refreshVersions(saved.taskId!);
        if (saved.runId) {
          const resumed = await loadBrowserAgentRun(saved.runId);
          setRun(resumed); setProposalSummary(resumed.proposal?.summary);
          setAwaitingFinalReview(resumed.status === "awaiting_review");
          setStage(resumed.status === "awaiting_scope_confirmation" || resumed.status === "awaiting_review" ? "awaiting" : resumed.status === "completed" ? "complete" : "idle");
        }
        setNotice("已恢复最近的私有工作区与 Agent 检查点");
      } catch { window.localStorage.removeItem(workspaceResumeKey); }
    })();
  }, []);

  useEffect(() => {
    if (!cloudSaved || !taskId || documentLoad.status !== "ready") return;
    window.localStorage.setItem(workspaceResumeKey, JSON.stringify({ taskId, runId: run?.id, fileName: documentLoad.document.file.name }));
  }, [cloudSaved, documentLoad, run?.id, taskId]);

  async function refreshVersions(id: string) {
    const history = await loadBrowserDocumentVersions(id);
    setVersions(history.versions.map((version) => ({
      id: version.id,
      label: version.origin === "import" ? "导入并通过结构检查" : version.origin === "agent" ? "Agent 写入并通过重开校验" : version.origin === "restore" ? "从历史版本恢复" : "用户创建的版本",
      time: new Date(version.created_at).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      actor: version.origin === "agent" ? "纸上鸭" : "你",
      current: version.id === history.currentVersionId,
    })));
  }

  const decide = async (decision: ProposalState) => {
    if (cloudSaved && run && taskId) {
      setProposal(decision);
      try {
        let current = await decideBrowserAgentRun(run.id, decision === "accepted" ? "approved" : "rejected");
        setRun(current);
        if (decision === "rejected") {
          setStage("idle");
          setNotice("修改计划已拒绝，文档版本保持不变");
          return;
        }
        setStage("applying");
        for (const label of ["正在生成局部内容", "正在原子写入新版本", "正在重开并校验 DOCX"] as const) {
          setNotice(label);
          current = await advanceBrowserAgentRun(current.id);
          setRun(current);
          if (current.status === "failed") throw new Error(current.failure?.message ?? "Agent 步骤失败");
        }
        if (current.status !== "awaiting_review" || !current.workingRevision) throw new Error("Agent 未进入最终复核状态");
        const fileName = documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx";
        const nextDocument = await loadCurrentTaskDocument(taskId, fileName);
        setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } }); setCurrentRevision(nextDocument.version.revision);
        await refreshVersions(taskId);
        setAwaitingFinalReview(true);
        setStage("awaiting");
        setNotice("新版本已显示在画布中，等待最终复核");
      } catch (error) {
        setStage("idle");
        setNotice(error instanceof Error ? error.message : "Agent 执行失败，可从检查点重试");
      }
      return;
    }
    setProposal(decision);
    setNotice(decision === "accepted" ? "演示建议已接受；当前 DOCX 字节不会改变" : decision === "rejected" ? "演示建议已拒绝，文档保持不变" : "演示决定已重置");
    if (decision !== "accepted") return;
    setStage("applying");
    const timer = window.setTimeout(() => {
      setStage("complete");
      setVersions((items) => items.some((item) => item.id === "demo-2") ? items : [{ id: "demo-2", label: "HITL 界面演示（未写回）", time: "刚刚", actor: "纸上鸭", current: true }, ...items.map((item) => ({ ...item, current: false }))]);
      setNotice("HITL 界面演示完成；下载仍是原始 DOCX");
    }, 1300);
    timers.current.push(timer);
  };

  const runAgent = async (prompt: string) => {
    if (!cloudSaved || !taskId) {
      setNotice("请先将真实 DOCX 保存到私有工作区");
      return;
    }
    setStage("analyzing");
    setNotice(`纸上鸭正在分析：“${prompt.slice(0, 24)}${prompt.length > 24 ? "…" : ""}”`);
    setAwaitingFinalReview(false);
    setProposalSummary(undefined);
    try {
      const created = await createBrowserAgentRun(taskId, prompt);
      const analyzed = await advanceBrowserAgentRun(created.id);
      if (analyzed.status === "failed") throw new Error(analyzed.failure?.message ?? "文档分析失败");
      setRun(analyzed);
      setProposal("pending");
      setProposalSummary(analyzed.proposal?.summary ?? "Agent 已完成范围分析，请确认后继续。");
      setStage("awaiting");
      setNotice("真实修改计划已绑定当前 revision，等待确认");
    } catch (error) {
      setStage("idle");
      setNotice(error instanceof Error ? error.message : "Agent 分析失败");
    }
  };

  const upload = async (kind: UploadAsset["kind"], file?: File) => {
    if (!file) return;
    const isTemplate = kind === "template";
    const maySeedWorkingDocument = isTemplate || !sourceState.workingDocumentId;
    // Reference examples are persisted but must never replace the document
    // currently rendered in the canvas. Only a template upload changes it.
    if (maySeedWorkingDocument) setDocumentLoad({ status: "loading", fileName: file.name });
    setNotice(`正在本地检查 ${file.name}`);
    try {
      const bytes = await readDocxFile(file);
      const next = { kind, name: file.name, size: formatFileSize(file.size) };
      setAssets((items) => [...items.filter((item) => item.kind !== kind), next]);
      if (maySeedWorkingDocument && !productionPersistenceConfigured()) {
        setDocumentLoad({ status: "ready", document: { file, bytes } });
        setVersions([{ id: "local", label: isTemplate ? "本地原始模板" : "本地原始示例", time: "刚刚", actor: "你", current: true }]);
        setCloudSaved(false);
      } else if (!maySeedWorkingDocument) {
        // Reference context changed, so any proposal generated without this
        // example is stale even though the Working Document bytes are stable.
        setRun(undefined);
        setProposal("pending");
        setProposalSummary(undefined);
        setAwaitingFinalReview(false);
        setStage("idle");
      }
      if (productionPersistenceConfigured()) {
        setNotice(isTemplate ? `${file.name} 已打开，正在安全上传并建立不可变版本` : `${file.name} 已读取，正在作为参考示例安全上传`);
        const persisted = await persistSourceFile({ file, bytes, role: kind, taskId });
        const nextSourceState = reduceSourceRegistration(sourceState, persisted);
        setSourceState(nextSourceState);
        setTaskId(persisted.taskId);
        const createsWorkingDocument = isWorkingDocumentUpload(kind, persisted);
        const hadWorkingDocument = Boolean(sourceState.workingDocumentId);
        if (createsWorkingDocument && !hadWorkingDocument) {
          setDocumentLoad({ status: "ready", document: { file, bytes } });
          setVersions([{ id: persisted.versionId ?? "local", label: isTemplate ? "原始模板" : "完成示例", time: "刚刚", actor: "你", current: true }]);
          setCloudSaved(true);
          await refreshVersions(persisted.taskId);
          setNotice(`${file.name} 已保存为 Working Document，并建立版本 v1`);
        } else if (isTemplate && createsWorkingDocument && hadWorkingDocument) {
          setCloudSaved(true);
          await refreshVersions(persisted.taskId);
          setNotice(`${file.name} 已替换 Working Document，并建立新的不可变版本`);
        } else if (isTemplate && nextSourceState.workingDocumentId) {
          setCloudSaved(true);
          await refreshVersions(persisted.taskId);
          setNotice(`${file.name} 已保存；当前 Working Document 仍保持不变`);
        } else if (kind === "example") {
          setCloudSaved(Boolean(nextSourceState.workingDocumentId));
          setNotice(nextSourceState.workingDocumentId
            ? `${file.name} 已保存为参考示例，Working Document 未改变`
            : `${file.name} 已保存为参考示例；请继续上传模板以开始编辑`);
        }
      } else {
        setNotice(isTemplate
          ? `${file.name} 已在本地打开；云端服务尚未配置`
          : `${file.name} 已作为本地参考示例载入；云端服务尚未配置`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取文件失败，请重试。";
      setDocumentLoad({ status: "error", message });
      setNotice(message);
    }
  };

  const chooseWorkingDocument = (file?: File) => { void upload("template", file); };
  const downloadCurrent = async () => {
    if (documentLoad.status !== "ready") { setNotice("请先打开一份真实 DOCX"); return; }
    if (cloudSaved && taskId) {
      try {
        const exported = await createBrowserDocumentExport(taskId);
        const link = window.document.createElement("a");
        link.href = exported.downloadUrl;
        link.download = documentLoad.document.file.name;
        window.document.body.append(link); link.click(); link.remove();
        setNotice(`已生成版本 v${exported.export.number} 的私有下载链接`);
      } catch (error) { setNotice(error instanceof Error ? error.message : "导出失败"); }
      return;
    }
    downloadLocalDocument(documentLoad.document.file);
    setNotice(`正在下载原始文件 ${documentLoad.document.file.name}`);
  };

  const restoreVersion = async (id: string) => {
    if (cloudSaved && taskId) {
      try {
        const restored = await restoreBrowserDocumentVersion(taskId, id);
        const fileName = documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx";
        const nextDocument = await loadCurrentTaskDocument(taskId, fileName);
          setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } }); setCurrentRevision(nextDocument.version.revision);
        await refreshVersions(taskId);
        setVersionsOpen(false); setMobilePanel("none"); setNotice(`已创建恢复版本 v${restored.version.version_number}，完整历史已保留`);
      } catch (error) { setNotice(error instanceof Error ? error.message : "恢复版本失败"); }
      return;
    }
    setVersions((items) => [{ id: `v${items.length + 1}`, label: `恢复 ${id} 的内容`, time: "刚刚", actor: "你", current: true }, ...items.map((item) => ({ ...item, current: false }))]);
    setVersionsOpen(false); setMobilePanel("none"); setNotice(`已从 ${id} 创建新的恢复版本，历史记录仍完整保留`);
  };
  const cancelRun = async () => {
    timers.current.forEach(window.clearTimeout); timers.current = [];
    try { if (run && cloudSaved) setRun(await cancelBrowserAgentRun(run.id)); } catch { /* persisted latest state wins */ }
    setStage("idle"); setNotice("任务已取消，最近有效版本未受影响");
  };
  const finalReview = async (choice: "approved" | "rejected") => {
    if (!run?.workingRevision) return;
    try {
      const reviewed = await reviewBrowserAgentRun(run.id, choice, run.workingRevision);
      setRun(reviewed);
      setAwaitingFinalReview(false);
      setStage(choice === "approved" ? "complete" : "idle");
      setNotice(choice === "approved" ? "最终版本已确认，任务完成" : "最终版本已拒绝，决定已记录");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "最终复核失败");
    }
  };
  const generateImages = async () => {
    if (!taskId || !imageTargetNodeId.trim() || !imagePrompt.trim()) return;
    setImageBusy(true);
    try { const result = await generateBrowserImageCandidates({ taskId, prompt: imagePrompt.trim(), targetNodeId: imageTargetNodeId.trim(), count: 3 }); setImageCandidates(result.candidates); setNotice(`已生成 ${result.candidates.length} 个图片候选，请选择后应用`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "图片生成失败"); }
    finally { setImageBusy(false); }
  };
  const applyImage = async (candidate: BrowserImageCandidate) => {
    if (!taskId || !currentRevision) return;
    setImageBusy(true);
    try { const result = await applyBrowserImageCandidate({ taskId, assetId: candidate.id, targetNodeId: imageTargetNodeId.trim(), expectedRevision: currentRevision }); const nextDocument = await loadCurrentTaskDocument(taskId, documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx"); setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } }); setCurrentRevision(nextDocument.version.revision); setImageCandidates([]); await refreshVersions(taskId); setNotice(`图片已应用，创建新版本 v${result.versionNumber}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "图片应用失败，请刷新后重试"); }
    finally { setImageBusy(false); }
  };
  const retry = () => { setStage("idle"); setNotice("请重新发送要求；旧运行及最近有效版本会完整保留"); };

  return (
    <main className="workbench-app">
      <a className="skip-link" href="#document-canvas">跳到文档</a>
      <header className="topbar">
        <div className="brand-lockup"><PaperDuckMark /><div><strong>纸上鸭</strong><span>把 Word 真正做完</span></div></div>
        <div className="document-identity"><span className="doc-chip">DOCX</span><div><strong>{documentLoad.status === "ready" ? documentLoad.document.file.name : "尚未载入真实文档"}</strong><span><Cloud size={12} /> {documentLoad.status === "ready" ? cloudSaved ? "私有工作区已保存" : "本地预览 · 未上传" : "选择文件开始真实预览"}</span></div></div>
        <div className="top-actions"><span className="demo-badge">{cloudSaved ? "Agent LIVE" : "本地预览"}</span><button className="quiet-action" onClick={() => setVersionsOpen((open) => !open)} aria-expanded={versionsOpen}><History size={16} /><span>版本 {versions.length}</span><ChevronDown size={13} /></button><button className="export-button" onClick={downloadCurrent} disabled={documentLoad.status !== "ready"}><Download size={16} /> 下载当前文件</button><button className="mobile-menu" onClick={() => setMobilePanel(mobilePanel === "none" ? "agent" : "none")} aria-label="打开工作台菜单"><Menu size={20} /></button></div>
      </header>

      {versionsOpen && <div className="version-popover" role="dialog" aria-label="版本历史"><div className="version-heading"><div><span className="eyebrow">不可变历史</span><h2>版本记录</h2></div><button className="icon-button" onClick={() => setVersionsOpen(false)} aria-label="关闭版本记录"><X size={16} /></button></div><p>恢复会创建新版本，不会删除后续记录。</p><ol>{versions.map((version) => <li key={version.id} className={version.current ? "current" : ""}><span className="version-node">{version.current ? <Check size={12} /> : version.id.slice(1)}</span><div><strong>{version.label}</strong><small>{version.id} · {version.actor} · {version.time}</small></div>{!version.current && <button onClick={() => restoreVersion(version.id)}><RotateCcw size={12} /> 恢复</button>}</li>)}</ol></div>}

      <div className={`workspace-grid ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`}>
        {leftOpen ? <OutlinePanel assets={assets} onCollapse={() => setLeftOpen(false)} onUpload={upload} /> : <button className="edge-tab left" onClick={() => setLeftOpen(true)} aria-label="展开文档结构"><PanelLeftOpen size={17} /><span>结构</span></button>}
        <div id="document-canvas" className="document-column"><DocumentCanvas key={documentLoad.status === "ready" ? `${documentLoad.document.file.name}-${documentLoad.document.bytes.byteLength}` : documentLoad.status} loadState={documentLoad} proposal={proposal} onChoose={chooseWorkingDocument} onDecide={decide} liveAgent={cloudSaved} proposalSummary={proposalSummary} /></div>
        {rightOpen ? <AgentPanel stage={stage} proposal={proposal} onCollapse={() => setRightOpen(false)} onRun={runAgent} onCancel={cancelRun} onRetry={retry} onDecide={decide} mode={cloudSaved ? "production" : "local"} proposalSummary={proposalSummary} awaitingFinalReview={awaitingFinalReview} onFinalReview={finalReview} imageCandidates={imageCandidates} imageTargetNodeId={imageTargetNodeId} imagePrompt={imagePrompt} onImageTargetNodeIdChange={setImageTargetNodeId} onImagePromptChange={setImagePrompt} onGenerateImages={generateImages} onApplyImage={applyImage} imageBusy={imageBusy} /> : <button className="edge-tab right" onClick={() => setRightOpen(true)} aria-label="展开 Agent 面板"><PanelRightOpen size={17} /><span>Agent</span></button>}
      </div>

      <div className="mobile-dock" aria-label="移动端工作台导航"><button onClick={() => setMobilePanel("outline")} className={mobilePanel === "outline" ? "active" : ""}><FilePlus2 size={18} /><span>文档</span></button><button onClick={() => setMobilePanel("agent")} className={mobilePanel === "agent" ? "active" : ""}><Sparkles size={18} /><span>审批</span><i>1</i></button><button onClick={() => setMobilePanel("versions")} className={mobilePanel === "versions" ? "active" : ""}><History size={18} /><span>版本</span></button><button onClick={downloadCurrent}><Download size={18} /><span>下载</span></button></div>

      {mobilePanel !== "none" && <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={mobilePanel === "agent" ? "移动审批" : mobilePanel === "outline" ? "源文档" : "版本历史"}><div className="sheet-handle" /><button className="sheet-close" onClick={() => setMobilePanel("none")} aria-label="关闭"><X size={18} /></button>
        {mobilePanel === "agent" && <div className="mobile-approval"><span className="eyebrow">{cloudSaved ? "HITL 真实审批" : "本地预览"}</span><h2>{awaitingFinalReview ? "确认最终版本" : "确认局部改写建议"}</h2><p>{proposalSummary ?? "请先保存文档并让 Agent 生成绑定 revision 的修改计划。"}</p><div>{awaitingFinalReview ? <button className="mobile-approve" onClick={() => { void finalReview("approved"); setMobilePanel("none"); }}><Check size={16} /> 确认交付</button> : <button className="mobile-approve" onClick={() => { void decide("accepted"); setMobilePanel("none"); }} disabled={!proposalSummary}><Check size={16} /> 批准并应用</button>}<button onClick={() => { void decide("rejected"); setMobilePanel("none"); }} disabled={!proposalSummary}>拒绝</button></div></div>}
        {mobilePanel === "outline" && <div className="mobile-sources"><span className="eyebrow">任务输入</span><h2>源文档</h2>{assets.map((asset) => <div key={asset.kind}><FilePlus2 size={17} /><span><strong>{asset.kind === "template" ? "模板" : "示例"}</strong><small>{asset.name} · {asset.size}</small></span><Check size={15} /></div>)}</div>}
          {mobilePanel === "versions" && <div className="mobile-versions"><span className="eyebrow">不会覆盖历史</span><h2>版本</h2>{versions.slice(0, 4).map((version) => <button key={version.id} onClick={() => { if (!version.current) void restoreVersion(version.id); }}><span>{version.id}</span><div><strong>{version.label}</strong><small>{version.time} · {version.actor}</small></div>{!version.current && <RotateCcw size={14} />}</button>)}</div>}
      </div>}
      <div className="sr-only" role="status" aria-live="polite">{notice}</div><div className="toast" aria-hidden="true"><span className="toast-dot" />{notice}</div>
    </main>
  );
}
