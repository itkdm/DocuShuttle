"use client";

import { Check, ChevronDown, Cloud, Download, FilePlus2, History, Menu, PanelLeftOpen, PanelRightOpen, RotateCcw, Sparkles, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPanel } from "./agent-panel";
import { mergeTimelineEvents } from "./agent-timeline";
import { projectAgentThread } from "./agent-thread-projection";
import { DocumentCanvas } from "./document-canvas";
import { OutlinePanel } from "./outline-panel";
import { PaperDuckMark } from "./paperduck-mark";
import { TaskList } from "./task-list";
import { formatFileSize, readDocxFile } from "./docx-file";
import { persistSourceFile } from "@/modules/uploads/browser-source-upload";
import { emptySourceRegistrationState, isWorkingDocumentUpload, reduceSourceRegistration, type SourceRegistrationState } from "@/modules/uploads/source-role-semantics";
import { advanceBrowserAgentRun, applyBrowserImageCandidate, cancelBrowserAgentRun, createBrowserAgentRun, createBrowserDocumentExport, decideBrowserAgentRun, generateBrowserImageCandidates, inspectBrowserTaskDocument, loadBrowserAgentLoop, loadBrowserAgentRun, loadBrowserAgentTaskTimeline, loadBrowserConversationMessages, loadBrowserDocumentVersions, loadCurrentTaskDocument, restoreBrowserDocumentVersion, reviewBrowserAgentRun, runBrowserAgentLoopStream, resumeBrowserAgentLoopStream, type BrowserImageCandidate, type BrowserImageNode } from "@/modules/agent/browser-runtime";
import { useConversationStore } from "./conversation-store";
import { listBrowserTasks, loadBrowserTaskWorkspace, type TaskPage } from "@/modules/tasks/browser-tasks";
import type { TaskSummary } from "@/modules/tasks/domain";
import { taskIdFromPathname, taskUrl } from "@/modules/tasks/task-url";
import { ensureAnonymousSession } from "@/infrastructure/supabase/browser";
import type { AgentRun } from "@/modules/agent";
import type { AgentPermissionMode } from "@/modules/agent/application/loop";
import type { AgentStage, DocumentLoadState, ProposalState, UploadAsset, VersionItem } from "./types";

const initialAssets: UploadAsset[] = [];
const initialVersions: VersionItem[] = [
  { id: "pending", label: "等待导入文档", time: "当前", actor: "纸上鸭", versionNumber: 0, current: true },
];
export function Workbench() {
  const pathname = usePathname();
  const router = useRouter();
  const routeTaskId = taskIdFromPathname(pathname);
  const loadedTaskIdRef = useRef<string | undefined>(undefined);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<"none" | "outline" | "agent" | "versions">("none");
  const [proposal, setProposal] = useState<ProposalState>("pending");
  const [stage, setStage] = useState<AgentStage>("idle");
  const [assets, setAssets] = useState(initialAssets);
  const [sourceState, setSourceState] = useState<SourceRegistrationState>(emptySourceRegistrationState);
  const [documentLoad, setDocumentLoad] = useState<DocumentLoadState>(() => (
    routeTaskId ? { status: "loading", fileName: "正在打开任务" } : { status: "empty" }
  ));
  const [versions, setVersions] = useState(initialVersions);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [notice, setNotice] = useState("请选择真实 DOCX；首页保持空白，打开历史任务才会恢复文档和对话");
  const [taskId, setTaskId] = useState<string>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [nextTaskOffset, setNextTaskOffset] = useState<number | null>(null);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [run, setRun] = useState<AgentRun>();
  const [proposalSummary, setProposalSummary] = useState<string>();
  const [awaitingFinalReview, setAwaitingFinalReview] = useState(false);
  const [currentRevision, setCurrentRevision] = useState<string>();
  const [imageCandidates, setImageCandidates] = useState<BrowserImageCandidate[]>([]);
  const agentAbortRef = useRef<AbortController | undefined>(undefined);
  const [imageTargetNodeId, setImageTargetNodeId] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageNodes, setImageNodes] = useState<BrowserImageNode[]>([]);
  const [paragraphCount, setParagraphCount] = useState(0);
  const [tableCellCount, setTableCellCount] = useState(0);
  const { conversation, setConversation, loopResult, setLoopResult, liveEvents, setLiveEvents, timelineHistory, setTimelineHistory } = useConversationStore();
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>("default");
  const taskListRequestRef = useRef<Promise<TaskPage> | undefined>(undefined);

  const resetWorkspace = useCallback(() => {
    loadedTaskIdRef.current = undefined;
    setProposal("pending");
    setStage("idle");
    setAssets(initialAssets);
    setSourceState(emptySourceRegistrationState());
    setDocumentLoad({ status: "empty" });
    setVersions(initialVersions);
    setTaskId(undefined);
    setWorkspaceReady(false);
    setRun(undefined);
    setProposalSummary(undefined);
    setAwaitingFinalReview(false);
    setCurrentRevision(undefined);
    setImageCandidates([]);
    setImageTargetNodeId("");
    setImagePrompt("");
    setImageNodes([]);
    setParagraphCount(0);
    setTableCellCount(0);
    setConversation([]);
    setLoopResult(undefined);
    setLiveEvents([]);
    setTimelineHistory([]);
    setNotice("请选择真实 DOCX，或从左侧打开一个历史任务");
  }, [setConversation, setLoopResult, setLiveEvents, setTimelineHistory]);

  const refreshTaskList = async () => {
    if (taskListRequestRef.current) {
      try {
        const page = await taskListRequestRef.current;
        setTasks(page.tasks);
        setNextTaskOffset(page.nextOffset);
      } catch { setTasks([]); }
      return;
    }
    const request = (async () => {
      await ensureAnonymousSession();
      return listBrowserTasks();
    })();
    taskListRequestRef.current = request;
    setLoadingTasks(true);
    try {
      const page = await request;
      setTasks(page.tasks);
      setNextTaskOffset(page.nextOffset);
    } catch {
      setTasks([]);
      setNextTaskOffset(null);
    } finally {
      taskListRequestRef.current = undefined;
      setLoadingTasks(false);
    }
  };

  const loadMoreTasks = async () => {
    if (nextTaskOffset === null || loadingMoreTasks) return;
    setLoadingMoreTasks(true);
    try {
      await ensureAnonymousSession();
      const page = await listBrowserTasks(nextTaskOffset);
      setTasks((current) => [...current, ...page.tasks]);
      setNextTaskOffset(page.nextOffset);
    } finally {
      setLoadingMoreTasks(false);
    }
  };

  useEffect(() => { void refreshTaskList(); }, []);

  useEffect(() => {
    if (!routeTaskId) {
      if (loadedTaskIdRef.current) resetWorkspace();
      return;
    }
    if (loadedTaskIdRef.current === routeTaskId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        setDocumentLoad({ status: "loading", fileName: "正在打开任务" });
        setNotice("正在打开这个任务的最新文档和对话");
        const workspace = await loadBrowserTaskWorkspace(routeTaskId);
        if (abort.signal.aborted) return;
        let durableConversationLoaded = false;
        let nextSource = emptySourceRegistrationState();
        for (const source of workspace.sources) {
          nextSource = reduceSourceRegistration(nextSource, {
            sourceFileId: source.id,
            role: source.role,
            originalName: source.originalName,
            workingDocumentId: workspace.workingDocumentId,
            versionId: source.role === "template" || source.role === "example" ? source.id : undefined,
          });
        }
        setSourceState(nextSource);
        setAssets(workspace.sources.flatMap((source) => (
          source.role === "template" || source.role === "example"
            ? [{ kind: source.role, name: source.originalName, size: formatFileSize(source.byteLength) }]
            : []
        )));
        setTaskId(workspace.task.id);
        setWorkspaceReady(Boolean(workspace.workingDocumentId));
        setConversation([]);
        setConversationCursor(null);
        setLoopResult(undefined);
        setLiveEvents([]);
        setTimelineHistory([]);
        setRun(undefined);
        setProposalSummary(undefined);
        setAwaitingFinalReview(false);
        // These projections are independent after the workspace identity is
        // known. Fetch them concurrently so a slow document download or
        // Supabase history query does not block the other panels from
        // becoming interactive on refresh.
        const [durableResult, documentResult, inspectionResult, versionsResult, resumedResult, resumedLoopResult] = await Promise.allSettled([
          loadBrowserConversationMessages(workspace.task.id),
          workspace.workingDocumentId ? loadCurrentTaskDocument(workspace.task.id, workspace.fileName) : Promise.resolve(undefined),
          workspace.workingDocumentId ? inspectBrowserTaskDocument(workspace.task.id) : Promise.resolve(undefined),
          workspace.workingDocumentId ? loadBrowserDocumentVersions(workspace.task.id) : Promise.resolve(undefined),
          workspace.latestRunId ? loadBrowserAgentRun(workspace.latestRunId) : Promise.resolve(undefined),
          workspace.latestRunId ? loadBrowserAgentLoop(workspace.latestRunId) : Promise.resolve(undefined),
        ]);
        if (abort.signal.aborted) return;
        const durable = durableResult.status === "fulfilled" ? durableResult.value : undefined;
        if (durable) {
          durableConversationLoaded = durable.messages.length > 0;
          setConversationCursor(durable.nextCursor);
          setConversation(projectAgentThread({ messages: durable.messages, historicalEvents: [], activeEvents: [] }).turns.flatMap((turn) => [
            { id: turn.user.id, role: "user" as const, text: turn.user.content, runId: turn.runId, status: turn.user.deliveryStatus },
            ...(turn.assistant.finalContent ? [{ id: turn.assistant.messageId, role: "agent" as const, text: turn.assistant.finalContent, runId: turn.runId, status: "sent" as const }] : []),
          ]));
        }
        if (documentResult.status === "fulfilled" && documentResult.value) {
          const document = documentResult.value;
          setDocumentLoad({ status: "ready", document: { file: document.file, bytes: document.bytes } });
          setCurrentRevision(document.version.revision);
        } else if (!workspace.workingDocumentId) {
          setDocumentLoad({ status: "empty" });
          setVersions(initialVersions);
        }
        if (inspectionResult.status === "fulfilled" && inspectionResult.value) {
          const inspection = inspectionResult.value;
          setImageNodes(inspection.images);
          setParagraphCount(inspection.counts.paragraphs);
          setTableCellCount(inspection.counts.tableCells);
        }
        if (versionsResult.status === "fulfilled" && versionsResult.value) {
          const history = versionsResult.value;
          setVersions(history.versions.map((version) => ({
            id: version.id,
            versionNumber: version.version_number,
            label: version.origin === "import" ? "导入并通过结构检查" : version.origin === "agent" ? "Agent 写入并通过重开校验" : version.origin === "restore" ? "从历史版本恢复" : "用户创建的版本",
            time: new Date(version.created_at).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
            actor: version.origin === "agent" ? "纸上鸭" : "你",
            current: version.id === history.currentVersionId,
          })));
        }
        const resumed = resumedResult.status === "fulfilled" ? resumedResult.value : undefined;
        const resumedLoop = resumedLoopResult.status === "fulfilled" ? resumedLoopResult.value : undefined;
        if (resumed) {
          setRun(resumed);
          if (resumedLoop) {
            setLoopResult(resumedLoop);
            setLiveEvents((items) => mergeTimelineEvents(items, resumedLoop.events));
            if (!durableConversationLoaded) setConversation([]);
          } else setLoopResult(undefined);
          setAwaitingFinalReview(resumed.status === "awaiting_review");
          const resumedIsActive = ["queued", "analyzing", "generating", "applying", "validating"].includes(resumed.status);
          setStage(resumed.status === "awaiting_scope_confirmation" || resumed.status === "awaiting_review" ? "awaiting" : resumed.status === "completed" ? "complete" : resumedIsActive ? "analyzing" : "idle");
        } else setStage("idle");
        // Completed-run history is intentionally loaded by the independent
        // background effect below; it must not delay the first usable render
        // of the current document and conversation.
        setTimelineHistory([]);
        loadedTaskIdRef.current = workspace.task.id;
        setNotice(workspace.workingDocumentId ? "已打开这个任务的最新文档和对话" : "已打开历史任务；请继续上传文档");
      } catch (error) {
        if (abort.signal.aborted) return;
        loadedTaskIdRef.current = undefined;
        setDocumentLoad({ status: "error", message: error instanceof Error ? error.message : "任务打开失败" });
        setNotice(error instanceof Error ? `无法打开任务：${error.message}` : "无法打开任务");
      }
    })();
    return () => abort.abort();
  }, [routeTaskId, resetWorkspace, setConversation, setLiveEvents, setLoopResult, setTimelineHistory]);

  // Load completed runs independently from the document bootstrap. A large
  // DOCX preview can take several seconds; the conversation history should
  // not depend on that work finishing in the same effect or on a Strict Mode
  // bootstrap being aborted and restarted.
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void loadBrowserAgentTaskTimeline(taskId).then((history) => {
      if (cancelled) return;
      const historicalEvents = history.runs
        .filter((item) => item.id !== run?.id && ["completed", "failed", "cancelled"].includes(item.checkpoint?.status ?? item.status))
        .flatMap((item) => item.events);
      setTimelineHistory(historicalEvents);
    }).catch(() => {
      if (!cancelled) setTimelineHistory([]);
    });
    return () => { cancelled = true; };
  }, [taskId, run?.id, setTimelineHistory]);

  async function loadEarlierConversationMessages() {
    if (!taskId || !conversationCursor || loadingEarlierMessages) return;
    setLoadingEarlierMessages(true);
    try {
      const page = await loadBrowserConversationMessages(taskId, conversationCursor);
      const older = page.messages.flatMap((message) => {
        const text = message.parts.find((part) => part.type === "text")?.text;
        if (!text || (message.role !== "user" && message.role !== "assistant")) return [];
        return [{ id: message.id, role: message.role === "user" ? "user" as const : "agent" as const, text, runId: message.run_id ?? undefined, createdAt: message.created_at, status: message.delivery_status ?? "sent" }];
      });
      setConversation((items) => [...older, ...items]);
      setConversationCursor(page.nextCursor);
    } finally {
      setLoadingEarlierMessages(false);
    }
  }

  async function refreshVersions(id: string) {
    const history = await loadBrowserDocumentVersions(id);
    setVersions(history.versions.map((version) => ({
      id: version.id,
      versionNumber: version.version_number,
      label: version.origin === "import" ? "导入并通过结构检查" : version.origin === "agent" ? "Agent 写入并通过重开校验" : version.origin === "restore" ? "从历史版本恢复" : "用户创建的版本",
      time: new Date(version.created_at).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      actor: version.origin === "agent" ? "纸上鸭" : "你",
      current: version.id === history.currentVersionId,
    })));
  }

  const decide = async (decision: ProposalState) => {
    if (workspaceReady && run && taskId) {
      setProposal(decision);
      try {
        let current = await decideBrowserAgentRun(run.id, decision === "accepted" ? "approved" : "rejected");
        setRun(current);
        if (decision === "rejected") {
          setConversation((items) => [...items, { role: "agent", text: "我会保留当前文档，不写入这次建议。" }]);
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
        setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } }); setCurrentRevision(nextDocument.version.revision); const inspection = await inspectBrowserTaskDocument(taskId!); setImageNodes(inspection.images); setParagraphCount(inspection.counts.paragraphs); setTableCellCount(inspection.counts.tableCells);
        await refreshVersions(taskId);
        setAwaitingFinalReview(true);
        setStage("awaiting");
        setConversation((items) => [...items, { role: "agent", text: "范围已确认。新版本已写入并通过 DOCX 重开校验，请进行最终复核。" }]);
        setNotice("新版本已显示在画布中，等待最终复核");
      } catch (error) {
        setConversation((items) => [...items, { role: "agent", text: error instanceof Error ? `这次执行没有完成：${error.message}` : "这次执行没有完成，请重试。" }]);
        setStage("idle");
        setNotice(error instanceof Error ? error.message : "Agent 执行失败，可从检查点重试");
      }
      return;
    }
    setConversation((items) => [...items, { role: "agent", text: "请先打开一份 DOCX，建立文档工作区后我就可以开始处理。" }]);
    setNotice("请先打开一份 DOCX，建立文档工作区");
  };

  const runAgent = async (prompt: string) => {
    if (!workspaceReady || !taskId) {
      setNotice("请先打开一份 DOCX，建立文档工作区");
      return;
    }
    const localMessageId = crypto.randomUUID();
    setConversation((items) => [...items, { id: localMessageId, role: "user", text: prompt, status: "pending" }]);
    setStage("analyzing");
    setNotice(`纸上鸭正在处理你的请求：“${prompt.slice(0, 24)}${prompt.length > 24 ? "…" : ""}”`);
    setAwaitingFinalReview(false);
    setProposalSummary(undefined);
    const abortController = new AbortController();
    agentAbortRef.current = abortController;
    let activeRunForRecovery: AgentRun | undefined;
    try {
      // A completed/failed run is an immutable execution record, not a
      // conversation handle for the next user turn. Start a new run for the
      // next request; only an active approval checkpoint may be resumed by
      // the explicit approval controls.
      const startsFreshRun = !run || stage !== "awaiting" || run.status === "cancelled" || run.status === "completed" || run.status === "failed";
      if (startsFreshRun) {
        const previousEvents = liveEvents.length ? liveEvents : loopResult?.events ?? [];
        if (previousEvents.length) setTimelineHistory((items) => mergeTimelineEvents(items, previousEvents));
        setLiveEvents([]);
        setLoopResult(undefined);
      }
      // Show the user's turn immediately. The server emits the durable
      // turn.started event shortly afterwards; mergeTimelineEvents replaces
      // this local item when that event arrives.
      setLiveEvents((items) => mergeTimelineEvents(items, [{
        type: "turn.started",
        eventId: `local:${crypto.randomUUID()}`,
        timestamp: new Date().toISOString(),
        text: prompt,
        clientMessageId: localMessageId,
      }]));
      const activeRun = startsFreshRun ? await createBrowserAgentRun(taskId, prompt, localMessageId) : run;
      activeRunForRecovery = activeRun;
      setRun(activeRun);
      const result = await runBrowserAgentLoopStream(activeRun.id, prompt, permissionMode, (event) => {
        setLiveEvents((items) => mergeTimelineEvents(items, [event]));
        if (event.type === "model.delta") setNotice("纸上鸭正在回复");
        if (event.type === "tool.started") setNotice(`正在执行：${event.name ?? "工具"}`);
      }, abortController.signal, localMessageId);
      setLoopResult(result);
      setLiveEvents((items) => mergeTimelineEvents(items, result.events));
      setConversation((items) => items.map((item) => item.id === localMessageId ? { ...item, status: result.checkpoint.status === "failed" ? "failed" : "sent" } : item));
      if (result.checkpoint.status === "failed") {
        // The failed checkpoint already contains the user-facing assistant
        // message and turn.failed event. Keep the unified Timeline as the
        // source of truth instead of appending a second fallback message.
        setStage("idle");
        setNotice(result.checkpoint.finalText ?? "这次请求没有完成，请稍后重试。");
        return;
      }
      const replies = result.events.filter((event) => event.type === "assistant.message" && event.text).map((event) => event.text!);
      if (replies.length) setConversation((items) => [...items, ...replies.map((text) => ({ role: "agent" as const, text }))]);
      const wrote = result.events.some((event) => event.type === "tool.completed" && (event.name === "apply_text_change" || event.name === "apply_text_changes"));
      if (wrote && taskId) {
        // A document mutation is not user-visible until the immutable version
        // has been downloaded and parsed by the canvas. Do this before marking
        // the turn complete; otherwise the conversation can claim success
        // while the central document still renders the previous bytes.
        const fileName = documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx";
        const nextDocument = await loadCurrentTaskDocument(taskId, fileName);
        setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } });
        setCurrentRevision(nextDocument.version.revision);
        const inspection = await inspectBrowserTaskDocument(taskId);
        setImageNodes(inspection.images); setParagraphCount(inspection.counts.paragraphs); setTableCellCount(inspection.counts.tableCells);
        await refreshVersions(taskId);
      }
      setStage(result.checkpoint.pendingApproval || result.checkpoint.pendingUserQuestion ? "awaiting" : wrote ? "complete" : "idle");
      setNotice(result.checkpoint.pendingApproval
        ? "Agent 已完成读取并请求写入确认"
        : result.checkpoint.pendingUserQuestion
          ? "Agent 正在等待你的回答"
          : wrote ? "新版本已加载到文档画布" : "Agent 已完成本轮对话");
    } catch (error) {
      if (abortController.signal.aborted) return;
      // A model/provider can fail after the loop has durably saved an approval
      // checkpoint. Recover that checkpoint so the user sees the real next
      // action instead of a misleading generic failure message.
      const runToRecover = activeRunForRecovery ?? run;
      if (runToRecover) {
        try {
          const recovered = await loadBrowserAgentLoop(runToRecover.id);
          setLoopResult(recovered);
          setLiveEvents((items) => mergeTimelineEvents(items, recovered.events));
          if (recovered.checkpoint.pendingApproval || recovered.checkpoint.pendingUserQuestion) {
            setStage("awaiting");
            setNotice(recovered.checkpoint.pendingApproval ? "Agent 已完成读取并请求写入确认" : "Agent 正在等待你的回答");
            return;
          }
          if (["running", "completed"].includes(recovered.checkpoint.status)) {
            setStage(recovered.checkpoint.status === "completed" ? "idle" : "analyzing");
            setNotice(recovered.checkpoint.status === "completed" ? "连接恢复，已收到本轮结果" : "连接中断，Agent 仍在服务端运行；已恢复执行记录");
            return;
          }
        } catch { /* preserve the original error below */ }
      }
      const failureMessage = error instanceof Error ? error.message : "这次分析没有完成，请重试。";
      setConversation((items) => items.map((item) => item.id === localMessageId ? { ...item, status: "failed" } : item));
      setLiveEvents((items) => mergeTimelineEvents(items, [{
        type: "turn.failed",
        eventId: `local:failed:${crypto.randomUUID()}`,
        timestamp: new Date().toISOString(),
        error: failureMessage,
      }]));
      setConversation((items) => [...items, { role: "agent", text: error instanceof Error ? `这次分析没有完成：${error.message}` : "这次分析没有完成，请重试。" }]);
      setStage("idle");
      setNotice(error instanceof Error ? error.message : "Agent 分析失败");
    } finally {
      if (agentAbortRef.current === abortController) agentAbortRef.current = undefined;
    }
  };

  const decideLoop = async (choice: "approved" | "rejected") => {
    if (!run) return;
    setNotice(choice === "approved" ? "正在执行批准的操作…" : "已拒绝，正在继续后续处理…");
    const abortController = new AbortController();
    agentAbortRef.current = abortController;
    try {
      const result = await resumeBrowserAgentLoopStream(run.id, choice, (event) => {
        setLiveEvents((items) => mergeTimelineEvents(items, [event]));
        if (event.type === "tool.started") setNotice(`正在执行：${event.name ?? "工具"}`);
      }, abortController.signal);
      setLoopResult(result);
      setLiveEvents((items) => mergeTimelineEvents(items, result.events));
      const replies = result.events.filter((event) => event.type === "assistant.message" && event.text).map((event) => event.text!);
      if (replies.length) setConversation((items) => [...items, ...replies.map((text) => ({ role: "agent" as const, text }))]);
      if (result.checkpoint.status === "completed") {
        setProposalSummary(undefined);
        const wrote = result.events.some((event) => event.type === "tool.completed" && (event.name === "apply_text_change" || event.name === "apply_text_changes"));
        setStage(wrote ? "complete" : "idle");
        if (taskId) {
          const fileName = documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx";
          const nextDocument = await loadCurrentTaskDocument(taskId, fileName);
          setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } });
          setCurrentRevision(nextDocument.version.revision);
          await refreshVersions(taskId);
        }
        setNotice("Agent 已完成写入并通过版本校验");
      } else if (result.checkpoint.status === "awaiting_user") {
        setStage("awaiting");
        setNotice("Agent 需要你的下一步决定");
      } else if (result.checkpoint.status === "failed") {
        const finalText = result.checkpoint.finalText ?? "Agent 执行失败";
        setConversation((items) => [...items, { role: "agent", text: finalText }]);
        setStage("idle");
        setNotice(finalText);
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Agent 恢复失败";
      setConversation((items) => [...items, { role: "agent", text: `这次执行没有完成：${message}` }]);
      setStage("idle");
      setNotice(message);
    } finally {
      if (agentAbortRef.current === abortController) agentAbortRef.current = undefined;
    }
  };

  const startNewTask = () => {
    resetWorkspace();
    if (pathname !== "/") router.push("/");
  };

  const openTask = (id: string) => {
    if (id === routeTaskId) return;
    router.push(taskUrl(id));
  };

  const upload = async (kind: UploadAsset["kind"], file?: File) => {
    if (!file) return;
    const isTemplate = kind === "template";
    const creatingNewTask = !taskId;
    const maySeedWorkingDocument = isTemplate || !sourceState.workingDocumentId;
    // Reference examples are persisted but must never replace the document
    // currently rendered in the canvas. Only a template upload changes it.
    if (maySeedWorkingDocument) setDocumentLoad({ status: "loading", fileName: file.name });
    setNotice(`正在检查 ${file.name}`);
    try {
      const bytes = await readDocxFile(file);
      setLoopResult(undefined);
      if (creatingNewTask) {
        setConversation([]);
        setLiveEvents([]);
        setRun(undefined);
        setProposalSummary(undefined);
        setAwaitingFinalReview(false);
        setStage("idle");
      } else if (maySeedWorkingDocument) setRun(undefined);
      const next = { kind, name: file.name, size: formatFileSize(file.size) };
      setAssets((items) => [...items.filter((item) => item.kind !== kind), next]);
      if (!maySeedWorkingDocument) {
        // Reference context changed, so any proposal generated without this
        // example is stale even though the Working Document bytes are stable.
        setRun(undefined);
        setProposal("pending");
        setProposalSummary(undefined);
        setAwaitingFinalReview(false);
        setStage("idle");
      }
      setNotice(isTemplate ? `${file.name} 正在建立文档工作区` : `${file.name} 正在作为参考资料加入工作区`);
      const persisted = await persistSourceFile({ file, bytes, role: kind, taskId });
      const nextSourceState = reduceSourceRegistration(sourceState, persisted);
      setSourceState(nextSourceState);
      setTaskId(persisted.taskId);
      if (nextSourceState.workingDocumentId) {
        const inspection = await inspectBrowserTaskDocument(persisted.taskId);
        setImageNodes(inspection.images);
        setParagraphCount(inspection.counts.paragraphs);
        setTableCellCount(inspection.counts.tableCells);
      }
      const createsWorkingDocument = isWorkingDocumentUpload(kind, persisted);
      const hadWorkingDocument = Boolean(sourceState.workingDocumentId);
      if (createsWorkingDocument && !hadWorkingDocument) {
        setDocumentLoad({ status: "ready", document: { file, bytes } });
        setVersions([{ id: persisted.versionId ?? "initial", label: isTemplate ? "原始模板" : "完成示例", time: "刚刚", actor: "你", versionNumber: 0, current: true }]);
        setWorkspaceReady(true);
        await refreshVersions(persisted.taskId);
        setNotice(`${file.name} 已建立文档工作区，并创建版本 v1`);
      } else if (isTemplate && createsWorkingDocument && hadWorkingDocument) {
        setWorkspaceReady(true);
        await refreshVersions(persisted.taskId);
        setNotice(`${file.name} 已替换当前文档，并创建新的不可变版本`);
      } else if (isTemplate && nextSourceState.workingDocumentId) {
        setWorkspaceReady(true);
        await refreshVersions(persisted.taskId);
        setNotice(`${file.name} 已保存；当前文档保持不变`);
      } else if (kind === "example") {
        setWorkspaceReady(Boolean(nextSourceState.workingDocumentId));
        setNotice(nextSourceState.workingDocumentId
          ? `${file.name} 已作为参考资料加入，当前文档未改变`
          : `${file.name} 已加入参考资料；请继续上传模板以开始编辑`);
      }
      loadedTaskIdRef.current = persisted.taskId;
      if (creatingNewTask) router.replace(taskUrl(persisted.taskId));
      void refreshTaskList();
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取文件失败，请重试。";
      setDocumentLoad({ status: "error", message });
      setNotice(message);
    }
  };

  const chooseWorkingDocument = (file?: File) => { void upload("template", file); };
  const downloadCurrent = async () => {
    if (documentLoad.status !== "ready") { setNotice("请先打开一份真实 DOCX"); return; }
    if (workspaceReady && taskId) {
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
    setNotice("请先完成文档工作区初始化后再导出");
  };

  const restoreVersion = async (id: string) => {
    if (workspaceReady && taskId) {
      try {
        const restored = await restoreBrowserDocumentVersion(taskId, id);
        const fileName = documentLoad.status === "ready" ? documentLoad.document.file.name : "paperduck.docx";
        const nextDocument = await loadCurrentTaskDocument(taskId, fileName);
          setDocumentLoad({ status: "ready", document: { file: nextDocument.file, bytes: nextDocument.bytes } }); setCurrentRevision(nextDocument.version.revision); const inspection = await inspectBrowserTaskDocument(taskId); setImageNodes(inspection.images); setParagraphCount(inspection.counts.paragraphs); setTableCellCount(inspection.counts.tableCells);
        await refreshVersions(taskId);
        setVersionsOpen(false); setMobilePanel("none"); setNotice(`已创建恢复版本 v${restored.version.version_number}，完整历史已保留`);
      } catch (error) { setNotice(error instanceof Error ? error.message : "恢复版本失败"); }
      return;
    }
    setVersions((items) => [{ id: `v${items.length + 1}`, label: `恢复 ${id} 的内容`, time: "刚刚", actor: "你", current: true }, ...items.map((item) => ({ ...item, current: false }))]);
    setVersionsOpen(false); setMobilePanel("none"); setNotice(`已从 ${id} 创建新的恢复版本，历史记录仍完整保留`);
  };
  const cancelRun = async () => {
    agentAbortRef.current?.abort();
    try { if (run && workspaceReady) setRun(await cancelBrowserAgentRun(run.id)); } catch { /* persisted latest state wins */ }
    setStage("idle"); setNotice("任务已取消，最近有效版本未受影响");
  };
  const finalReview = async (choice: "approved" | "rejected") => {
    if (!run?.workingRevision) return;
    try {
      const reviewed = await reviewBrowserAgentRun(run.id, choice, run.workingRevision);
      setRun(reviewed);
      setAwaitingFinalReview(false);
      setStage(choice === "approved" ? "complete" : "idle");
      setConversation((items) => [...items, { role: "agent", text: choice === "approved" ? "最终版本已确认，任务完成。" : "这版结果已拒绝；历史版本保持不变。" }]);
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
  return (
    <main className="workbench-app">
      <a className="skip-link" href="#document-canvas">跳到文档</a>
      <header className="topbar">
        <button className="brand-lockup" type="button" onClick={startNewTask} aria-label="回到空白工作台"><PaperDuckMark /><div><strong>纸上鸭</strong><span>放心写，嘎嘎改</span></div></button>
        <div className="document-identity"><span className="doc-chip">DOCX</span><div><strong>{documentLoad.status === "ready" ? documentLoad.document.file.name : "尚未载入文档"}</strong><span><Cloud size={12} /> {workspaceReady ? "工作区已保存" : "选择文件开始"}</span></div></div>
        <div className="top-actions"><button className="quiet-action" onClick={() => setVersionsOpen((open) => !open)} aria-expanded={versionsOpen}><History size={16} /><span>版本 {versions.find((version) => version.current)?.versionNumber ?? 0}</span><ChevronDown size={13} /></button><button className="export-button" onClick={downloadCurrent} disabled={documentLoad.status !== "ready" || !workspaceReady}><Download size={16} /> 下载当前文件</button><button className="mobile-menu" onClick={() => setMobilePanel(mobilePanel === "none" ? "agent" : "none")} aria-label="打开工作台菜单"><Menu size={20} /></button></div>
      </header>

      {versionsOpen && <div className="version-popover" role="dialog" aria-label="版本历史"><div className="version-heading"><div><span className="eyebrow">不可变历史</span><h2>版本记录</h2></div><button className="icon-button" onClick={() => setVersionsOpen(false)} aria-label="关闭版本记录"><X size={16} /></button></div><p>恢复会创建新版本，不会删除后续记录。</p><ol>{versions.map((version) => <li key={version.id} className={version.current ? "current" : ""}><span className="version-node">{version.current ? <Check size={12} /> : version.id.slice(1)}</span><div><strong>{version.label}</strong><small>{version.id} · {version.actor} · {version.time}</small></div>{!version.current && <button onClick={() => restoreVersion(version.id)}><RotateCcw size={12} /> 恢复</button>}</li>)}</ol></div>}

      <div className={`workspace-grid ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`}>
        {leftOpen ? <OutlinePanel assets={assets} onCollapse={() => setLeftOpen(false)} onUpload={upload} documentReady={documentLoad.status === "ready"} paragraphCount={paragraphCount} tableCellCount={tableCellCount} imageCount={imageNodes.length} tasks={tasks} activeTaskId={taskId} onSelectTask={openTask} onCreateTask={startNewTask} onLoadMoreTasks={loadMoreTasks} hasMoreTasks={nextTaskOffset !== null} loadingMoreTasks={loadingMoreTasks} loadingTasks={loadingTasks} /> : <button className="edge-tab left" onClick={() => setLeftOpen(true)} aria-label="展开文档结构"><PanelLeftOpen size={17} /><span>结构</span></button>}
        <div id="document-canvas" className="document-column"><DocumentCanvas key={documentLoad.status === "ready" ? `${documentLoad.document.file.name}-${documentLoad.document.bytes.byteLength}` : documentLoad.status} loadState={documentLoad} proposal={proposal} onChoose={chooseWorkingDocument} onDecide={decide} proposalSummary={proposalSummary} /></div>
        {rightOpen ? <AgentPanel stage={stage} proposal={proposal} run={run} loopResult={loopResult} liveEvents={liveEvents} timelineHistory={timelineHistory} onLoopApproval={decideLoop} conversation={conversation} onCollapse={() => setRightOpen(false)} onRun={runAgent} onCancel={cancelRun} onDecide={decide} workspaceReady={workspaceReady} permissionMode={permissionMode} onPermissionModeChange={setPermissionMode} proposalSummary={proposalSummary} awaitingFinalReview={awaitingFinalReview} onFinalReview={finalReview} imageCandidates={imageCandidates} imageNodes={imageNodes} imageTargetNodeId={imageTargetNodeId} imagePrompt={imagePrompt} onImageTargetNodeIdChange={setImageTargetNodeId} onImagePromptChange={setImagePrompt} onGenerateImages={generateImages} onApplyImage={applyImage} imageBusy={imageBusy} onLoadEarlier={loadEarlierConversationMessages} hasEarlierMessages={Boolean(conversationCursor)} loadingEarlierMessages={loadingEarlierMessages} loadingWorkspace={Boolean(routeTaskId && documentLoad.status === "loading")} /> : <button className="edge-tab right" onClick={() => setRightOpen(true)} aria-label="展开 Agent 面板"><PanelRightOpen size={17} /><span>Agent</span></button>}
      </div>

      <div className="mobile-dock" aria-label="移动端工作台导航"><button onClick={() => setMobilePanel("outline")} className={mobilePanel === "outline" ? "active" : ""}><FilePlus2 size={18} /><span>文档</span></button><button onClick={() => setMobilePanel("agent")} className={mobilePanel === "agent" ? "active" : ""}><Sparkles size={18} /><span>审批</span><i>1</i></button><button onClick={() => setMobilePanel("versions")} className={mobilePanel === "versions" ? "active" : ""}><History size={18} /><span>版本</span></button><button onClick={downloadCurrent}><Download size={18} /><span>下载</span></button></div>

      {mobilePanel !== "none" && <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={mobilePanel === "agent" ? "移动审批" : mobilePanel === "outline" ? "源文档" : "版本历史"}><div className="sheet-handle" /><button className="sheet-close" onClick={() => setMobilePanel("none")} aria-label="关闭"><X size={18} /></button>
        {mobilePanel === "agent" && <div className="mobile-approval"><span className="eyebrow">{awaitingFinalReview ? "需要确认" : "Agent 工作区"}</span><h2>{awaitingFinalReview ? "确认最终版本" : "确认局部改写建议"}</h2><p>{proposalSummary ?? "请先打开文档并让 Agent 生成修改计划。"}</p><div>{awaitingFinalReview ? <button className="mobile-approve" onClick={() => { void finalReview("approved"); setMobilePanel("none"); }}><Check size={16} /> 确认交付</button> : <button className="mobile-approve" onClick={() => { void decide("accepted"); setMobilePanel("none"); }} disabled={!proposalSummary}><Check size={16} /> 批准并应用</button>}<button onClick={() => { void decide("rejected"); setMobilePanel("none"); }} disabled={!proposalSummary}>拒绝</button></div></div>}
        {mobilePanel === "outline" && <div className="mobile-sources"><span className="eyebrow">任务输入</span><h2>源文档</h2>{assets.length ? assets.map((asset) => <div key={asset.kind}><FilePlus2 size={17} /><span><strong>{asset.kind === "template" ? "空白模板" : "完成示例"}</strong><small>{asset.name} · {asset.size}</small></span><Check size={15} /></div>) : <p>先选择空白模板或完成示例，再开始一个任务。</p>}<TaskList tasks={tasks} activeTaskId={taskId} onSelectTask={(id) => { openTask(id); setMobilePanel("none"); }} onCreateTask={() => { startNewTask(); setMobilePanel("none"); }} onLoadMore={loadMoreTasks} hasMore={nextTaskOffset !== null} loadingMore={loadingMoreTasks} loading={loadingTasks} /></div>}
          {mobilePanel === "versions" && <div className="mobile-versions"><span className="eyebrow">不会覆盖历史</span><h2>版本</h2>{versions.slice(0, 4).map((version) => <button key={version.id} onClick={() => { if (!version.current) void restoreVersion(version.id); }}><span>{version.id}</span><div><strong>{version.label}</strong><small>{version.time} · {version.actor}</small></div>{!version.current && <RotateCcw size={14} />}</button>)}</div>}
      </div>}
      <div className="sr-only" role="status" aria-live="polite">{notice}</div><div className="toast" aria-hidden="true"><span className="toast-dot" />{notice}</div>
    </main>
  );
}
