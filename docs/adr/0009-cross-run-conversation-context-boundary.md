# ADR-0009：跨 Run Conversation Context Boundary

状态：Accepted

## 决策

同一个 `conversation` 可以包含多个独立的 Agent Run，但运行恢复与新 Run 使用不同的数据边界：

- approval resume、`ask_user` resume、SSE/transport recovery 和 crash recovery 只读取该 Run 的
  `AgentLoopCheckpoint`；它们不得重新加载 Conversation history。
- 新 Run 只通过 `AgentConversationContextPort` 读取 canonical `messages` 中的 user/assistant
  文本，并排除当前 `runId` 的消息。Tool call/result、Agent event、effect receipt、approval
  resolution、权限和预算状态不属于跨 Run 语义上下文。
- 历史读取限制为最近 200 条语义消息，并按时间正序交给已有确定性
  `compactAgentMessages`。截断只记录不含正文的 engineering event。

## 原因

Checkpoint 是同 Run 的恢复事实源，不是跨 Run 的聊天记录；EventStore 是活动投影，也不是模型
记忆。将两个边界分开可以避免把旧工具副作用、审批状态或运行计数泄漏到新 Run，同时保留用户
可见的对话连续性。当前 Run 的 user message 已由 `create_agent_turn` 原子写入 canonical
messages，因此读取历史时必须排除它，避免模型看到重复 prompt。

## 后果

Conversation context adapter 只负责读取和清洗 canonical message projection，AgentLoopStore
继续只负责 checkpoint、事件、receipt 和 interaction persistence。真实文档状态仍必须由当前
Document Tools、working document 和 revision/version 提供，不能由旧对话摘要替代。
