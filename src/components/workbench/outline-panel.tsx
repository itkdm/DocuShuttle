import { ChevronDown, FileCheck2, FileText, ImageIcon, PanelLeftClose, Table2 } from "lucide-react";
import type { UploadAsset } from "./types";

interface OutlinePanelProps {
  assets: UploadAsset[];
  onCollapse: () => void;
  onUpload: (kind: UploadAsset["kind"], file?: File) => void;
}

const outline = [
  { icon: FileText, label: "实验目的", page: "1" },
  { icon: FileText, label: "实验环境", page: "1" },
  { icon: Table2, label: "实验步骤与记录", page: "2", active: true },
  { icon: ImageIcon, label: "网络拓扑图", page: "3" },
  { icon: FileText, label: "实验总结", page: "4" },
];

export function OutlinePanel({ assets, onCollapse, onUpload }: OutlinePanelProps) {
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
              <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => onUpload(kind, event.target.files?.[0])} />
              <span className="source-icon">{asset ? <FileCheck2 size={17} /> : <FileText size={17} />}</span>
              <span className="source-copy"><strong>{title}</strong><small>{asset ? asset.name : "选择 .docx"}</small></span>
              <span className="source-action">{asset ? "替换" : "+"}</span>
            </label>
          );
        })}
      </div>
      <nav className="outline-nav" aria-label="页面内导航">
        <button className="outline-section" aria-expanded="true"><span>正文 · 4 页</span><ChevronDown size={15} /></button>
        <ol>{outline.map(({ icon: Icon, label, page, active }) => <li key={label}><button className={active ? "active" : ""}><Icon size={15} /><span>{label}</span><small>{page}</small></button></li>)}</ol>
      </nav>
      <div className="outline-legend"><span><i className="legend-dot generated" /> 待生成 3</span><span><i className="legend-dot locked" /> 已锁定 5</span></div>
    </aside>
  );
}
