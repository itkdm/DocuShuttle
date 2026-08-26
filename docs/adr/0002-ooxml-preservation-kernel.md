# ADR-0002：自研 OOXML Preservation Kernel

状态：Accepted
日期：2026-08-26

## 决策

纸上鸭自研一个范围克制的 OOXML Preservation Kernel，作为导入、稳定寻址、原子修改、验证与导出的权威 Document Engine。浏览器预览是独立可替换 adapter，HTML 不回写 DOCX。SuperDoc 不作为权威内核；未来只有在硬门槛恢复后才可重新评估为 UI adapter。

自研不等于实现完整 Word。V1 只支持可验证的 paragraph/text range、table cell 和 image 原子操作；遇到 field、revision、复杂 drawing 或不能安全定位的结构时拒绝写入并报告，不做破坏性 best-effort。

## SuperDoc 实测证据

POC 使用四份真实 DOCX：空白表格模板、完成示例、派生模板和包含 10 张图片的大报告。

- 基础 open/save 和直接文本、表格、图片修改可以导出并重开。
- npm 当前 `@superdoc/sdk@2.6.0` 声明的 Windows/Linux/macOS 平台包同版本未发布，registry 返回 E404；POC 被迫降级到 2.5.0。
- SDK 2.5.0 在 4/4 文件中都能创建修订并在保存重开后列出相同 ID，且标记 `refStability: stable`、`resolvableById: true`，但紧接着 `trackChanges.decide(ids)` 全部返回 `TARGET_NOT_FOUND`。
- no-op 往返在 3/4 文件中删除 `footnotes.xml`、`endnotes.xml` 及相应声明/关系，并在所有样本中改写部分未目标 XML。被删除的当前样本仅含默认分隔符，未证明用户脚注正文丢失，但已经证明未知 OOXML 部件会被静默裁剪。
- mutation 脚本的最终通过依赖记录修订失败后，从原文件重新打开并使用 direct fallback；这不等于 HITL/修订能力通过。

这些结果违反发布完整性、跨检查点审批和未修改部件保留三个核心门槛。独立架构审查同意拒绝其作为权威内核。

POC 与机器可读报告位于 `research/document-engine/poc-superdoc`；包含个人信息的输入和生成输出不提交仓库。

## 自研内核边界

- **SourcePackage**：原始 bytes immutable；建立 ZIP entry 清单和 hash；no-op 直接返回原 bytes。
- **Inspector/Manifest**：索引 main document、relationships、段落、表格/单元格、图片和页眉页脚；识别 footnotes、endnotes、fields、bookmarks、content controls 等构造并报告支持级别。
- **Stable Address**：优先 `w14:paraId`、表格/单元格/段落路径、drawing `docPr` 与关系 ID，并附带内容 fingerprint 与 source revision。
- **Atomic Operations**：带 expected text/hash 前置条件的文本替换、单元格内容设置、图片替换；失败不生成版本。
- **Exporter**：只 patch 明确 XML/media entry；未知和未触及 entry 的解压后字节必须保持不变。
- **Validator**：检查 ZIP、XML、content types、relationship targets、媒体、未触及 entry hash、目标语义差异和二次重开。

### V1 安全边界（2026-08-26）

- `TargetMode="External"` relationship 不会被解析、下载或跟随。普通外部关系以
  `RELATIONSHIP_EXTERNAL_TARGET` error 拒绝；普通 Word 超链接只以 warning 暴露，作为
  inert metadata 保留，不触发网络访问。
- 含 `vbaProject.bin`/`vbaData.bin`、VBA relationship，或 macro-enabled/VBA content
  type 的包统一返回 `MACRO_CONTENT_UNSUPPORTED` error。上传完成和任何 mutation 都拒绝
  这类包；V1 不执行、不重写，也不承诺保留宏。
- 该策略同时检查 package part、`[Content_Types].xml` 和 `.rels`，因此不能通过把
  `.docm` 改名为 `.docx` 或只删除一个声明来绕过。

HITL 使用应用层 Proposal/Decision 与不可变版本实现，不依赖 Word tracked changes。

## 库策略与许可

可使用 MIT/Apache-2.0 的 ZIP、XML 验证和只读预览库，但领域与应用层只依赖自有 port。当前决策移除了 SuperDoc 的 AGPL 强制条件；最终仓库许可证仍由产品决定。

## SuperDoc 重评条件

至少需要：平台包完整发布；4/4 跨保存修订决定通过；含真实脚注的 no-op 不丢 part；两轮真实 fixture、Office/WPS 和 Vercel 验证通过。即使重评也先作为可替换 adapter，不自动成为权威导出内核。
