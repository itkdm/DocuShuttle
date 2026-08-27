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
- `AgentLoopCheckpoint` 持久化消息、工具结果、迭代次数、待审批调用和终态，支持故障恢复、重试和前端刷新。
- 迭代次数、时间、token 和工具调用数量都有安全预算；工具错误作为结果返回模型，使 Agent 可以解释、重试或向用户提问。

## 文档工具

当前 Loop 已接入 `inspect_document`、`list_document_regions`、`read_document_region`、`inspect_node_capabilities`、`plan_text_change`、`apply_text_change`、`list_source_documents`、`read_source_document`、`list_document_versions`、`restore_document_version` 和 `export_document`。其中来源资料保持 template/example/auxiliary 语义隔离；`inspect_node_capabilities` 只返回语义节点能力，`plan_text_change` 是不写入的语义化 dry-run，`apply_text_change` 与 `restore_document_version` 是需要确认的副作用工具，导出只记录 immutable version 并返回短期下载地址。写工具即使在完全批准模式也会先执行 dry-run，避免跳过目标、能力和重叠检查。

旧的 `analyze/generate/apply/validate` 仍可作为兼容生命周期和事务执行器，但不能决定 Agent 的语义流程；它们会逐步收敛为上述工具的实现。

## 模型配置

文本模型统一使用 OpenAI-compatible Chat Completions 接口。服务端通过 `DEEPSEEK_API_KEY`（或 `OPENAI_API_KEY`）、`DEEPSEEK_BASE_URL`（或 `OPENAI_BASE_URL`）和 `DEEPSEEK_MODEL`（或 `OPENAI_MODEL`）配置，不在代码中写死供应商或模型别名。当前适配器基于 Vercel AI SDK 的 `@ai-sdk/openai`，因此 DeepSeek、OpenAI 或自托管兼容网关都能复用同一端口；不使用 Anthropic API。

## HITL、版本与流式展示

工具需要批准时只保存 interrupt，不占用长连接；批准/拒绝后从 checkpoint 恢复。Token、assistant 消息、工具状态和错误仅用于实时展示，刷新后由持久化事件重放。文档画布只在一次原子版本提交成功后更新，避免半写入 DOCX。
