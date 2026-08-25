import { AlertCircle, Check, FileUp, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocumentLoadState, ProposalState } from "./types";

interface DocumentCanvasProps {
  loadState: DocumentLoadState;
  proposal: ProposalState;
  onChoose: (file?: File) => void;
  onDecide: (decision: ProposalState) => void;
  liveAgent: boolean;
  proposalSummary?: string;
}

function DocxRenderer({ bytes, onError }: { bytes: ArrayBuffer; onError: (message: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let active = true;
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    body.replaceChildren();
    styles.replaceChildren();
    setRendering(true);
    import("docx-preview")
      .then(({ renderAsync }) => renderAsync(bytes.slice(0), body, styles, {
        className: "paperduck-docx", inWrapper: true, breakPages: true,
        ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
        useBase64URL: true, renderHeaders: true, renderFooters: true,
      }))
      .then(() => { if (active) setRendering(false); })
      .catch((error: unknown) => {
        if (!active) return;
        const detail = error instanceof Error ? error.message : "未知渲染错误";
        onError(`DOCX 无法渲染：${detail}`);
      });
    return () => { active = false; };
  }, [bytes, onError]);

  return <><div ref={styleRef} />{rendering && <div className="docx-rendering" role="status"><LoaderCircle size={20} /> 正在排版真实 DOCX…</div>}<div ref={bodyRef} className="docx-preview-host" data-testid="docx-preview" /></>;
}

export function DocumentCanvas({ loadState, proposal, onChoose, onDecide, liveAgent, proposalSummary }: DocumentCanvasProps) {
  const [renderError, setRenderError] = useState<string | null>(null);
  const proposalText = proposal === "accepted" ? "通过分层访问控制与日志审计，验证不同角色的最小权限边界。" : proposal === "rejected" ? "已保留原文，不会写回当前文件。" : "验证访问控制策略是否按预期生效，并记录审计日志中的关键事件。";
  const error = loadState.status === "error" ? loadState.message : renderError;

  return (
    <section className="canvas-shell" aria-label="Working Document 文档画布">
      <div className="canvas-toolbar">
        <div className="preview-state"><i className={loadState.status === "ready" ? "ready" : ""} />{loadState.status === "ready" ? "真实本地预览" : loadState.status === "loading" ? "正在读取" : "尚未载入文档"}</div>
        <label className="canvas-upload"><input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChoose(event.target.files?.[0])} /><FileUp size={14} />{loadState.status === "ready" ? "更换文档" : "选择 DOCX"}</label>
      </div>
      <div className="paper-stage">
        {loadState.status === "empty" && <div className="canvas-empty"><span className="empty-duck">鸭</span><span className="eyebrow">REAL DOCX WORKSPACE</span><h1>把一份真实 Word 放到桌上</h1><p>文件会先在当前浏览器内检查和排版；正式环境配置完成后，将通过短时签名直传私有对象存储。</p><label><input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onChoose(event.target.files?.[0])} /><FileUp size={17} /> 打开 .docx</label><small>最大 20 MB · 不支持旧版 .doc</small></div>}
        {loadState.status === "loading" && <div className="canvas-loading" role="status"><LoaderCircle size={26} /><strong>正在检查并打开</strong><span>{loadState.fileName}</span></div>}
        {error && <div className="canvas-error" role="alert"><AlertCircle size={28} /><strong>这份文档暂时打不开</strong><p>{error}</p><label><input type="file" accept=".docx" onChange={(event) => onChoose(event.target.files?.[0])} /><RotateCcw size={15} /> 选择其他文件</label></div>}
        {loadState.status === "ready" && !error && <div className="real-document-wrap">
          <DocxRenderer bytes={loadState.document.bytes} onError={setRenderError} />
          {proposalSummary && <aside className={`preview-proposal ${proposal}`} aria-label="Agent 修改建议"><div><span className="duck-pin">◆</span><strong>{liveAgent ? "真实 Agent 建议" : "本地建议预览"}</strong><small>{liveAgent ? "绑定当前文档 revision" : "不会写回当前 DOCX"}</small></div><p>{proposalSummary || proposalText}</p>{proposal === "pending" ? <div className="proposal-actions"><button className="accept" onClick={() => onDecide("accepted")}><Check size={14} /> 批准</button><button onClick={() => onDecide("rejected")}><X size={14} /> 拒绝</button></div> : <span className="decision-note">{proposal === "accepted" ? "已批准" : "已拒绝"}</span>}</aside>}
        </div>}
      </div>
    </section>
  );
}
