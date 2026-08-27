# Agent 运行时

PaperDuck 使用模型驱动的、可恢复的 Tool Loop。模型每一轮都可以直接回复、调用一个或多个工具，或请求用户补充/批准；下一步不由文档业务状态表预先决定。

```text
用户消息 → checkpoint → OpenAI-compatible model
                         ├─ assistant message → 继续或完成
                         ├─ tool call → schema/权限/预算校验 → tool result → 下一轮
                         └─ ask/approval → 持久化 interrupt → 用户恢复
```

## 边界

- `AgentModelPort` 只负责把消息和工具描述交给模型并解析模型决策，不拥有 Supabase、Storage 或 DOCX 写权限。
- `AgentTool` 是 provider-neutral 能力，参数必须由 Zod schema 校验；工具执行由应用层注入 `runId`、用户身份和当前文档 revision。
- 所有写工具都必须经过文档引擎、临时对象、结构校验和 revision CAS；模型不能直接修改数据库或对象存储。
- `AgentLoopCheckpoint` 持久化消息、工具结果、迭代次数、待审批调用和终态（包括 completed、failed、cancelled），支持故障恢复、重试和前端刷新；取消会追加 `turn.cancelled`，不能被旧循环保存覆盖。
- 迭代次数、时间、token 和工具调用数量都有安全预算；工具错误作为结果返回模型，使 Agent 可以解释、重试或向用户提问。

### 上下文边界与压缩

`AgentLoopRunner` 在每次模型决策前对 provider-facing transcript 应用可配置的
`AgentContextCompactionPolicy`。默认同时限制消息数量和字符预算，保留系统消息、
最近的对话单元，以及由历史用户目标和工具事实（revision、nodeId、变更数、风险、
校验结果）组成的确定性摘要。assistant tool-call 与对应的 tool result 始终作为一个
单元保留，避免 OpenAI-compatible 消息失配；摘要不会额外调用模型，也不会把隐藏
Chain-of-Thought 写入用户界面。完整的用户可见执行过程仍保存在 `trace` 中。

Timeline 可以跨同一任务的多个 run 回放，但新 run 不会未经 revision 校验直接继承
旧 run 的工具结果。这样历史只用于展示，当前 Agent 决策始终基于当前 run 的事实，
后续如需跨轮记忆，应在独立的 conversation/context 层显式实现并重新校验文档版本。

## 文档工具

当前 Loop 已接入 `inspect_document`、`list_document_regions`、`read_document_region`、`inspect_node_capabilities`、`plan_text_change`、`apply_text_change`、`list_source_documents`、`read_source_document`、`list_document_versions`、`restore_document_version` 和 `export_document`。其中来源资料保持 template/example/auxiliary 语义隔离；`inspect_node_capabilities` 只返回语义节点能力，`plan_text_change` 是不写入的语义化 dry-run，`apply_text_change` 与 `restore_document_version` 是需要确认的副作用工具，导出只记录 immutable version 并返回短期下载地址。写工具即使在完全批准模式也会先执行 dry-run，避免跳过目标、能力和重叠检查。

旧的 `analyze/generate/apply/validate` 仍可作为兼容生命周期和事务执行器，但不能决定 Agent 的语义流程；它们会逐步收敛为上述工具的实现。

## 模型配置

文本模型统一使用 OpenAI-compatible Chat Completions 接口。服务端通过 `DEEPSEEK_API_KEY`（或 `OPENAI_API_KEY`）、`DEEPSEEK_BASE_URL`（或 `OPENAI_BASE_URL`）和 `DEEPSEEK_MODEL`（或 `OPENAI_MODEL`）配置，不在代码中写死供应商或模型别名。当前适配器基于 Vercel AI SDK 的 `@ai-sdk/openai`，因此 DeepSeek、OpenAI 或自托管兼容网关都能复用同一端口；不使用 Anthropic API。

## HITL、版本与流式展示

工具需要批准时只保存 interrupt，不占用长连接；批准/拒绝后从 checkpoint 恢复。Token、assistant 消息、工具状态和错误仅用于实时展示，刷新后由持久化事件重放。文档画布只在一次原子版本提交成功后更新，避免半写入 DOCX。

运行诊断以 `loopCheckpoint.trace` 为事实源：它记录模型边界、公开文本、工具生命周期、审批解决和终态事件，默认保留最近 200 条；服务端异常日志不得记录模型密钥、系统提示词或未脱敏工具详情。
