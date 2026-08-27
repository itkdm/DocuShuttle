# ADR-0006：OOXML Preservation Kernel Foundation Migration

状态：Accepted · Foundation 1 已实现

## 决策

Document Kernel 的 XML 寻址采用 source-preserving、namespace-aware 的元素索引，而不是以正则表达式匹配嵌套标签。解析结果使用 JavaScript UTF-16 code-unit offset 作为统一 `SourceSpan` 坐标；每个节点保留原始 source slice、open/content/close/end span 和递归 children。索引只用于理解和定位，写回仍然只对显式 mutation span 做 patch，不经过通用 XML serializer。

这一层放在 OOXML infrastructure 内，`DocumentEnginePort`、Agent tools 和领域模型不依赖解析器类型。未来替换 parser 只需保持同一组 source-span 与语义索引适配器。

## 为什么现在做

旧的非贪婪正则无法正确处理嵌套 `<w:tbl>`，会在内层闭合标签处截断外层范围，导致路径、fingerprint 和单元格写入不可靠。Foundation 1 先修正坐标和嵌套结构，再扩展嵌套表、文本框和内容控件；不通过放宽安全检查来增加覆盖率。

## 当前实现与证据

- `lossless-xml.ts` 实现带栈的无损元素扫描，跳过 XML 声明、注释和 CDATA，并保留未知元素/属性的原文。
- `xml.ts` 的 `findElementRanges` 已通过该索引返回完整嵌套范围；现有 kernel patch compiler 的外部契约保持不变。
- `lossless-xml.test.ts` 覆盖嵌套范围、原始 lexical source、注释/CDATA/声明；完整测试同时覆盖真实 DOCX、未触及 ZIP part 哈希和失败原子性。

## 后续迁移顺序

1. P2：让递归索引暴露嵌套表的语义 cell 节点，并为外层包裹内表的 cell 增加能力说明。
2. P3：以 Feature Adapter 识别文本框及 AlternateContent coherence group。
3. P4：以 Feature Adapter 识别内容控件，保留 `sdtPr` 与锁定策略。
4. Foundation 2/3/4：把 OPC relationship graph、NodeId/Locator/Fingerprint/Remap 和 capability registry 从 inspector 中进一步拆出。
5. Foundation 5/6：将 mutation planner、dry-run 和分层 validation report 提升为明确的 application port；保持现有 `mutate` 兼容入口。

## 不变的安全边界

原始 DOCX 不原地修改；未声明的 ZIP part 必须保持 hash；所有 mutation 先整体 resolve/validate，再内存应用、重开检查和提交版本；无法证明安全的节点继续 fail closed。
