import { ChevronDown, FileCheck2, FileText, ImageIcon, PanelLeftClose, Table2 } from "lucide-react";
import type { UploadAsset } from "./types";

interface OutlinePanelProps {
  assets: UploadAsset[];
  onCollapse: () => void;
  onUpload: (kind: UploadAsset["kind"], file?: File) => void;
}

interface OutlinePanelPropsExtended extends OutlinePanelProps { documentReady?: boolean; imageCount?: number; tableCellCount?: number; }
export function OutlinePanel({ assets, onCollapse, onUpload, documentReady = false, imageCount = 0, tableCellCount = 0 }: OutlinePanelPropsExtended) {
  const getAsset = (kind: UploadAsset["kind"]) => assets.find((item) => item.kind === kind);
  return (
    <aside className="outline-panel" aria-label="文档结构">
      <div className="panel-heading">
        <div><span className="eyebrow">工作区</span><h2>文档结构</h2></div>
        <button className="icon-button" onClick={onCollapse} aria-label="收起文档结构"><PanelLeftClose size={17} /></button>
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
      <nav className="outline-nav" aria-label="页面内导航">
        <button className="outline-section" aria-expanded="true"><span>{documentReady ? "已解析的文档节点" : "等待文档解析"}</span><ChevronDown size={15} /></button>
        <ol>{documentReady ? <><li><div className="outline-node"><FileText size={15} /><span>段落节点</span><small>由 DOCX 解析</small></div></li><li><div className="outline-node"><Table2 size={15} /><span>表格单元格</span><small>{tableCellCount} 个</small></div></li><li><div className="outline-node"><ImageIcon size={15} /><span>图片节点</span><small>{imageCount} 个</small></div></li></> : <li><div className="outline-empty">上传真实 DOCX 后显示结构，不预填示例章节。</div></li>}</ol>
      </nav>
      <div className="outline-legend"><span><i className="legend-dot generated" /> 由 Agent 运行状态决定</span><span><i className="legend-dot locked" /> 未解析节点不显示</span></div>
    </aside>
  );
}
