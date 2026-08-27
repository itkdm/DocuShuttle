# ADR-0006：OOXML Preservation Kernel Foundation Migration

状态：Accepted · Foundation 1–6 的第一阶段基础已实现；复杂 Feature 写入仍按 guarded 边界推进

## 决策

Document Kernel 的 XML 寻址采用 source-preserving、namespace-aware 的元素索引，而不是以正则表达式匹配嵌套标签。解析结果使用 JavaScript UTF-16 code-unit offset 作为统一 `SourceSpan` 坐标；每个节点保留原始 source slice、open/content/close/end span 和递归 children。索引只用于理解和定位，写回仍然只对显式 mutation span 做 patch，不经过通用 XML serializer。

这一层放在 OOXML infrastructure 内，`DocumentEnginePort`、Agent tools 和领域模型不依赖解析器类型。未来替换 parser 只需保持同一组 source-span 与语义索引适配器。

## 为什么现在做

旧的非贪婪正则无法正确处理嵌套 `<w:tbl>`，会在内层闭合标签处截断外层范围，导致路径、fingerprint 和单元格写入不可靠。Foundation 1 先修正坐标和嵌套结构，再扩展嵌套表、文本框和内容控件；不通过放宽安全检查来增加覆盖率。

## 当前实现与证据

- `lossless-xml.ts` 实现带栈的无损元素扫描，跳过 XML 声明、注释和 CDATA，并保留未知元素/属性的原文。
- `xml.ts` 的 `findElementRanges` 已通过该索引返回完整嵌套范围；现有 kernel patch compiler 的外部契约保持不变。
- `lossless-xml.test.ts` 覆盖嵌套范围、原始 lexical source、注释/CDATA/声明；kernel 回归覆盖真实 DOCX、未触及 ZIP part 哈希、嵌套 cell 写入和外层容器 fail-closed。
- 文本框段落会以 `textbox[n]/p[n]` 语义路径暴露，并携带 `replace-text: guarded` 能力；`mc:AlternateContent` 会被识别为需要 Choice/Fallback coherence 的保留组，尚未开放写入。
- `capability-registry.ts` 集中产生节点级 operation capability；Agent 只消费 `supported/guarded/unsupported` 与稳定 reason code，不感知 OOXML parser 类型。
- `opc-graph.ts` 统一保存全部 package parts、source hash 和 relationship；图片索引不再重复解析关系。
- `node-identity.ts` 提供 NodeId/Locator/NativeIdentity/Fingerprint 的 sidecar remap，歧义匹配显式返回 `ambiguous`。
- `planMutation` 提供不写包的 dry-run，提前执行 target、precondition 和 overlap resolve；`DocumentInspection.validation` 提供分层验证报告。
- `feature-adapter-registry.ts` 与 `capability-catalog.ts` 提供可注册 Feature Adapter 和机器可读 conformance 目录；签名、字段、修订、内容控件等区域按 guarded 策略处理。

## 后续迁移顺序

1. P3 完整写入：建立文本框/AlternateContent Feature Adapter，Choice 与 Fallback 必须作为 coherence group 一起更新。
2. P4：以 Feature Adapter 识别内容控件，保留 `sdtPr` 与锁定策略。
3. TextProjection 扩展：增加更多显式 format policy，并继续以真实 Word/WPS corpus 验证。
4. Foundation 6 增量：补齐 relationship/reference、schema baseline-diff 和 identity validation 的更多真实 fixture。

## 不变的安全边界

原始 DOCX 不原地修改；未声明的 ZIP part 必须保持 hash；所有 mutation 先整体 resolve/validate，再内存应用、重开检查和提交版本；无法证明安全的节点继续 fail closed。
