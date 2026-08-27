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
- `AgentLoopCheckpoint` 只持久化模型恢复所需的 transcript、工具结果、迭代次数、pending interaction 和终态，支持故障恢复与前端刷新；它不是事件日志或消息投影。取消会追加 `turn.cancelled`，不能被旧循环保存覆盖。
- 迭代次数、时间、token 和工具调用数量都有安全预算；工具错误作为结果返回模型，使 Agent 可以解释、重试或向用户提问。

### 上下文边界与压缩

`AgentLoopRunner` 在每次模型决策前对 provider-facing transcript 应用可配置的
`AgentContextCompactionPolicy`。默认同时限制消息数量和字符预算，保留系统消息、
最近的对话单元，以及由历史用户目标和工具事实（revision、nodeId、变更数、风险、
校验结果）组成的确定性摘要。assistant tool-call 与对应的 tool result 始终作为一个
单元保留，避免 OpenAI-compatible 消息失配；摘要不会额外调用模型，也不会把隐藏
Chain-of-Thought 写入用户界面。`trace` 只保留最近 200 条诊断快照；完整执行事实写入
`agent_run_events`，用户语义消息单独写入 `messages`。

同一任务拥有一个稳定的 conversation/thread；每个用户 turn 创建一个独立、可审计的
run，但新 run 会从该 conversation 的上一条模型 transcript 继续，并在下一次工具调用
前重新读取和校验当前文档 revision。Timeline 只负责回放所有 run 的真实事件，不能把
trace 原样当作模型上下文；模型上下文仍由 checkpoint messages 和上述 compaction policy
独立维护。

数据库对每个 task 强制最多一个非终态 run（`queued`、执行中或等待 HITL）。创建新
run 前 API 会先检查当前 conversation 的 pending interaction；即使两个浏览器请求
同时通过了检查，`agent_runs_one_active_per_task_idx` 也会以唯一约束拒绝第二个插入，
返回 `TURN_NOT_ALLOWED`，不会产生分叉或覆盖 checkpoint。终态保存后该约束自动释放，
下一轮才能从同一 conversation 创建新的 run。

## 文档工具

当前 Loop 已接入 `inspect_document`、`list_document_regions`、`read_document_region`、`inspect_node_capabilities`、`plan_text_change`、`apply_text_change`、`list_source_documents`、`read_source_document`、`list_document_versions`、`restore_document_version` 和 `export_document`。其中来源资料保持 template/example/auxiliary 语义隔离；`inspect_node_capabilities` 只返回语义节点能力，`plan_text_change` 是不写入的语义化 dry-run，`apply_text_change` 与 `restore_document_version` 是需要确认的副作用工具，导出只记录 immutable version 并返回短期下载地址。写工具即使在完全批准模式也会先执行 dry-run，避免跳过目标、能力和重叠检查。

文档写入工具内部继续执行派生 OOXML、重开校验、revision CAS 和 promotion；这些是文档事务边界，不是 Agent 顶层状态。

## 模型配置

文本模型统一使用 OpenAI-compatible Chat Completions 接口。服务端通过 `DEEPSEEK_API_KEY`（或 `OPENAI_API_KEY`）、`DEEPSEEK_BASE_URL`（或 `OPENAI_BASE_URL`）和 `DEEPSEEK_MODEL`（或 `OPENAI_MODEL`）配置，不在代码中写死供应商或模型别名。当前适配器基于 Vercel AI SDK 的 `@ai-sdk/openai`，因此 DeepSeek、OpenAI 或自托管兼容网关都能复用同一端口；不使用 Anthropic API。

## HITL、版本与流式展示

## Agent Event Protocol

`src/modules/agent/application/events.ts` 是唯一事件协议定义位置。`AgentEventPayload`
是当前真实运行事件的 discriminated union，`AgentEvent` 统一携带必需的
`eventId`、`runId`、`timestamp` 和可选 live `sequence`；`DurableAgentEvent` 将
`sequence` 收紧为必需字段。Runtime、Supabase persistence、SSE、Browser replay 和
Workbench projection 均直接消费这套类型。事件身份只使用 `eventId`，跨 run 只按
`runId` 分组，durable 排序只按 `sequence`；`turnId` 不属于协议。

终态事件统一使用 `turn.completed`、`turn.failed` 和 `turn.cancelled`。数据库物理列
保存 `run_id/sequence`，JSON event 保存协议 payload，读取时在 persistence boundary
重建完整 durable event；未知事件在 replay validation 阶段过滤。

工具的 `requiresApproval` 只声明敏感性；Permission Policy 决定是否真的产生人工 interrupt。
`default` 模式保存 approval interaction，不占用长连接；`full` 模式自动批准并继续工具执行。
模型请求补充信息（`ask_user`）保存为不同类型的 user-input interaction，用户回答后继续同一 run 和
conversation，而不是创建无上下文的新 run。Token、assistant 消息、工具状态和错误仅
用于实时展示，刷新后由持久化事件重放。文档画布只在一次原子版本提交成功后更新，
避免半写入 DOCX。

运行诊断以独立 EventStore 为事实源，事件序列由数据库 RPC 在单次事务中分配并去重；checkpoint 只保留最近 200 条 bounded trace 作为恢复快照。每个副作用工具使用 `runId:callId` 作为稳定幂等键，结果写入 Effect Receipt，重试优先重放 Receipt。服务端异常日志不得记录模型密钥、系统提示词或未脱敏工具详情。

## Pending Interaction 与权限策略

`AgentLoopCheckpoint` 只使用一个 `pendingInteraction`：

- `approval`：包含稳定的 `interactionId`、`callId`、`toolName` 和已通过 schema 校验的 `input`；
- `user_input`：包含稳定的 `interactionId` 和 `question`。

`status = awaiting_approval` 只与 approval interaction 对应，`status = awaiting_user` 只与
user-input interaction 对应；`running`、终态和取消状态不得残留 runtime interaction。
`final_review` 不属于 Tool Loop interrupt，本轮仍由产品层保留。

`requiresApproval && permissionMode = default` 才暂停并等待人工批准；`full` 只表示当前
Run 的 automatic approval，不是账户级权限，也不绕过 Zod、Tool guardrail、Document Engine、
revision CAS、OOXML validation、immutable version、Effect Receipt、idempotency、授权或取消竞争。
`ask_user` 在两种权限模式都可以暂停，因为它是缺少用户事实的 user-input interaction，而不是审批。
审批和回答都通过 `interactionId` 原子 claim，重复消费必须失败；审批额外校验 `callId`。

## 运行状态与恢复契约

`agent_runs.status` 只表达运行生命周期：`queued`、`running`、`awaiting_approval`、
`awaiting_user`、`awaiting_review`、`completed`、`failed`、`cancelled`。模型驱动的
执行顺序只存在于 `AgentLoopRunner`；没有独立 TurnId，`runId` 是界面可见的一次宏观
用户回合，`conversationId` 负责跨回合上下文归属。

恢复时先读取 checkpoint，再通过 `claim_agent_loop_interaction` 原子领取审批或用户回答边界；
取消先取得 `agent_runs` 行锁，文档提交 RPC 在同一行锁下拒绝 `cancelled` 运行，避免
取消与不可变版本提交产生不一致。租约只覆盖 `queued/running`，过期运行会被回收为
`cancelled`，并同步修正 checkpoint 状态。
