# OOXML 内核覆盖率：现状、缺口与商业化路径

状态：Draft  
日期：2026-08-27  
范围：Document Engine（自研 OOXML Preservation Kernel）  
不改动：Agent 编排、存储、鉴权。本文件只讨论「真实 Word 如何被打开、寻址、写入、导出」。

## 1. 问题

纸上鸭的核心承诺是：用户丢进一份真实 `.docx`，Agent 在**这份文档上**改完，导出去还能用 Word / WPS 打开，版式大体还在。

当前内核已经能：

- 打开多数合法 OOXML 包（宏、损坏包除外）；
- 对普通段落、非嵌套表单元格、普通图片做原子写入；
- 未触及的 ZIP part 字节级保持不变。

但一批非常常见的真实文档（实验报告、申请表、课程模板、带封面的公文）会在「写入」上打折：嵌套表格、文本框、内容控件、域、嵌入对象还不能作为一等公民被安全改写。这不是用户文档「不合法」，是内核解析深度不够。

商业上必须把这句话立住：

> **绝大多数真实 Word 能打开、该改的区域能改、没改的部分与 Word 重开后仍可用。**  
> 「绝大多数」指个人用户的作业、报告、申请材料、业务模板；不是实现完整 Microsoft Word。

## 2. 产品对「完美」的定义

不可测的「100% 与 Word 像素级一致」不能当目标。本内核的完美是可验证的四条：

1. **打开**：合法 `.docx` 能进入 Working Document；只有宏、损坏包、危险外部关系整包拒绝。
2. **保真**：未声明修改的 ZIP entry 哈希不变；导出后 Word / WPS 重开无修复提示。
3. **写入精确**：被批准的节点按 `node_id` + fingerprint 改中；改完再 inspect，目标文本/图片符合预期。
4. **失败可解释**：某区域暂不能写时，返回结构原因，不得静默改坏，也不得把整份文档打成只读。

达不到 4 的区域叫「暂不可写」，不是「危险到不能用这个产品」。

## 3. 当前实现（真实代码路径）

内核入口是 `DocumentEnginePort`：`inspect` / `mutate` / `validate`。实现类 `OoxmlPreservationKernel`。

```text
字节
  → package-security.preflightZipPackage   ZIP 炸弹/路径/目录
  → package-model.loadPackage              解压、UTF-8 XML、OPC graph、宏、Content_Types
  → inspector.indexDocument                无损 XML 源树切段落/表/图
  → inspect 返回 nodes + diagnostics
  → mutate：对目标节点做字符串补丁
  → 重开 validate + 未触及 entry 哈希核对
```

关键文件：

| 职责 | 文件 |
|---|---|
| 端口 | `src/modules/documents/application/document-engine-port.ts` |
| 内核 | `src/modules/documents/infrastructure/ooxml/ooxml-preservation-kernel.ts` |
| ZIP 预检 | `package-security.ts` |
| 包模型 | `package-model.ts` |
| OPC 关系图 | `opc-graph.ts` / `relationship-utils.ts` |
| 节点索引 | `inspector.ts` |
| 字符串 XML | `xml.ts` |
| 打开 vs 写入 | `diagnostic-policy.ts` |
| 上传闸门 | `src/modules/uploads/complete-source-upload.ts` |

### 3.1 打开

`loadPackage` 把 DOCX 当 OPC ZIP：列出全部 entry、建立 `parts + relationships` 图、校验 XML well-formed、检查主文档/关系/宏。  
`diagnostic-policy` 把诊断分成两类：

- **包完整性 error**：缺 `word/document.xml`、非法 XML、宏、会出网的非超链接外部关系 → 上传失败。
- **能力 warning**：嵌套表、文本框、域、修订、书签、内容控件 → **允许打开**，写入时再按节点判断。

ZIP 结束记录后的填充字节已忽略（WPS/Word 导出常见）。

### 3.2 寻址

节点种类只有三种：`paragraph` / `table-cell` / `image`。

定位方式是 **带 UTF-16 source span 的无损 XML 源树**，不是可回写 DOM；图片、超链接等跨 part 引用统一通过 OPC graph 解析：

```106:118:src/modules/documents/infrastructure/ooxml/xml.ts
export function findElementRanges(xml: string, qualifiedName: string): XmlRange[] {
  const pattern = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`,
    "g",
  );
```

`lossless-xml.ts` 以栈匹配开始/闭合标签，保留原始 source slice、open/content/close/end span 和 children；因此嵌套范围不会在内层闭合标签处截断。`opc-graph.ts` 保留所有未知 part，并提供按 source part 查询 relationship、规范化 target 和 source hash 的统一入口。

图片靠 `r:embed` + relationships；同一 media part 被多处引用则拒绝替换（避免一改全改）。

`node_id` 由 `kind + entry + 锚点` 的哈希构成，不吃可见文本，跨版本可稳定引用。

### 3.3 写入

`mutate` 只接受：

- `replace-text`：目标段落的 `w:t` 里，期望串必须恰好出现一次，且不能跨 run。
- `set-cell-text`：替换整个单元格可见文本。
- `replace-image`：同 content-type 替换 media part。

写入前 `assertSafeTextContainer`：若该节点 XML 内出现域、修订、内容控件、文本框、altChunk、object，拒绝这一次操作，不影响其他节点。

补丁完成后：只改声明过的 entry → 重新 `loadPackage` → 未改 entry 哈希必须相同 → 再核对目标语义。

### 3.4 上传如何接到内核

`CompleteSourceUpload` 只对 **包完整性 error** 拒绝。能力 warning 会进 manifest，文档仍成为 Working Document。Agent 的 `inspect_document` 同样不再因为 warning 整工具失败。

## 4. 真实文档上的缺口（有证据）

对工作区实验报告的粗测：

| 文件 | 结构 | 打开 | 写入含义 |
|---|---|---|---|
| 实验2.docx | 1 张表、不嵌套 | 可以 | 段落+单元格均可按当前算法写 |
| 实验1.2.docx | 287 段、3 表、2 处嵌套、1 个 `w:object` | 可以 | 正文段落可写；嵌套信息表不能当单元格写；嵌入对象不写 |
| 实验6.docx | ZIP 尾部填充 / 包不完整 | 视包完整性 | 填充已放行；缺主文档的包仍拒绝 |

中国高校实验报告、申请表、封面页的高频结构正好是：**表中表、文本框标题、偶尔 OLE 公式**。这是目标用户，不是边角。

## 5. 业界对照

| 路线 | 代表 | 对复杂结构 | 纸上鸭能否抄 |
|---|---|---|---|
| 完整排版引擎 | Word、ONLYOFFICE、Collabora | 嵌套表、文本框是一等对象 | 不能整引擎搬进来；体积、许可、保真不可控 |
| 打开即保留未知 | python-docx | 不支持的特性 round-trip 留下 | **打开策略应对齐** |
| 转 HTML 再转回 | mammoth 等 | 覆盖快，样式必丢 | **禁止作为权威导出** |
| 应用内对象模型 | Word Copilot / Office.js | 复杂编辑交给 Word | 我们没有 Word 进程 |

结论：纸上鸭必须继续自研补丁内核，但解析层要从「正则切标签」升级到「XML 树 + 递归块模型」。打开策略学 python-docx，写入覆盖按用户文档频率补齐，导出保真守住「未触及 part 不变」。

## 6. 目标架构

```text
                    inspect / mutate / validate
                                │
                    ┌───────────┴───────────┐
                    │   Block model (新)     │
                    │ document / hdr / ftr   │
                    │  └ paragraph           │
                    │  └ table               │
                    │      └ row → cell      │
                    │          └ paragraph   │
                    │          └ table*      │
                    │  └ drawing / txbx      │
                    │  └ sdt (content ctrl)  │
                    └───────────┬───────────┘
                                │
              只把「要改的叶子」编译成 entry 补丁
                                │
                    未声明的 XML 与 media 原样写回
```

原则：

1. **树，而不是正则。** `fast-xml-parser` 已用于校验，索引应改为带偏移的树遍历，或手写带栈的标签扫描（保留字节偏移以便补丁）。嵌套表路径形如 `tbl[0]/tr[0]/tc[1]/tbl[0]/tr[1]/tc[0]`。
2. **块可递归。** 单元格的孩子可以是段落或表；文本框的孩子是段落。Agent 看到的仍是 `node_id`，不暴露 OOXML。
3. **能力是节点属性，不是文件属性。** `writable: true | false` + `reason`。文件含嵌套表，只把不能安全写的节点标上，其余照写。
4. **写入编译器。** 先在树上改语义，再生成最小 XML 补丁。禁止把整份 `document.xml` 重序列化（会重排属性、丢未知子元）。
5. **校验不变。** 未触及 entry 哈希、目标 fingerprint、Word/WPS 重开，仍是发布门槛。

## 7. 分阶段（按用户文档频率）

### P0 已完成

打开与写入分离；嵌套表/文本框不再挡上传；ZIP 尾填充可打开。

### P1 解析器换树（已完成）

- 用带源偏移的 XML 遍历替换 `findElementRanges`。
- 表、行、单元格只收集**直接子级**，嵌套表成为单元格的 child table。
- 回归：现有 kernel 单测 + 实验2 行为不变。

现有 `lossless-xml.ts` 已提供统一 UTF-16 source span 和递归 children；现有 kernel 回归保持通过。

### P2 嵌套表格可写（基础能力已完成）

- 索引内层表单元格并赋予稳定 `node_id`。
- `set-cell-text` 对内层格生效；外层格若包含内表会 fail closed，不会清空内层内容。
- 已有 fixture 回归覆盖内层写入与外层容器拒绝；真实实验1.2 的 Word/WPS round-trip 仍是下一验收门槛。

### P3 文本框内文本（识别与防护已完成，写入待 Feature Adapter）

- 识别 `w:txbxContent`（及 `mc:AlternateContent` 里 VML fallback）。
- 框内段落已作为带 `textbox[n]/p[n]` 路径的可读节点暴露，并标记 `replace-text: guarded`；当前写入仍 fail closed。
- `mc:AlternateContent` 已诊断并保留，Choice+Fallback 两份文本尚未开放写入；必须由 Feature Adapter 作为 coherence group 一起改。
- 验收：封面标题在框里的模板能安全读取；可写验收留待 Adapter 完成。

### P4 内容控件

- `w:sdt` / `sdtContent` 是企业模板的正确写入点。
- 写 `sdtContent` 里的段落/表格，不拆 `sdtPr` 绑定。
- 锁定控件（`showingPlcHdr` / locking）只提示，不强行打穿。

### P5 域与页眉页脚中的复杂域

- 页码、日期：默认不改域结果，或按「更新域」语义处理，禁止把 `DATE` 写死成普通文字（除非用户明确「改成固定字」）。
- 页眉页脚普通段落已索引；P5 补域。

### P6 明确永不假装支持

- 宏：拒绝。
- OLE/嵌入对象：预览可标「请在 Word 中编辑」，内核不解释对象流。
- 修订标记：V1 继续用应用层 HITL，不把 `w:ins` 当纯文本覆盖。
- HTML 往返：禁止作为权威内核。

## 8. 语料与验收

内核是核心技术，验收必须用真实文档，不能只用 `createDocx()` 玩具包。

最低语料：

1. 工作区已有实验 1.2 / 2 / 6（及同构报告）。
2. 带文本框封面的模板。
3. 带内容控件的表单。
4. Word 与 WPS 各另存一份，证明不是单一生成器。
5. 含图片、页眉页脚、超链接的「正常复杂文档」。

每份语料三条硬指标：

- no-op 导出哈希或 Word 重开无修复；
- 对「应可写节点」做一次单元格或段落写入，目标对、其余 entry 哈希不变；
- 对「暂不可写节点」必须失败并带 code，不得改包。

通过线（商业可用的工程定义，不是营销）：

- 个人作业/实验报告类：**打开 100%（合法 docx）**；**正文+表格（含一层嵌套）可写 ≥ 95% 的可见文本节点**。
- 封面文本框、内容控件：P3/P4 完成后纳入同一条。
- 嵌入对象、宏：允许不可写，但必须在 UI/Agent 中说清。

## 9. 不做什么

- 不把「支持嵌套表」实现成「把外层表当扁平 Excel」。
- 不靠放宽校验假装覆盖率（例如关掉未触及 entry 检查）。
- 不引入完整 Office 引擎来换短期 demo。
- 不在 UI 层用 `docx-preview` 的 HTML 回写 DOCX。

## 10. 建议的下一步

立刻做 **P1 树解析 + P2 嵌套表写入**。这是目标用户文档里最高频、也是当前正则方案的硬伤。P3/P4 紧随其后。P0 的打开闸门保持，不再倒退回「有复杂结构就拒收」。

本文件是内核覆盖率的工作文件，与 [ADR-0002](../adr/0002-ooxml-preservation-kernel.md) 的保真决策兼容：保真不变，覆盖率靠加深解析，不靠降低安全。
