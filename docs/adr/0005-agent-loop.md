# ADR 0005：PaperDuck 的模型驱动 Agent Loop

状态：Accepted  ���
日期：2026-08-26

## 决策

PaperDuck 自研一个 provider-neutral 的 Tool Loop，模型通过 OpenAI-compatible Chat Completions 适配器返回文本、工具调用或用户中断。工具由应用层注册并用 Zod 校验；文档工具只能通过 Document Engine、不可变版本和 revision CAS 产生副作用。

Loop checkpoint 暂存于 `agent_runs.state.loopCheckpoint`，并采用乐观锁；每轮对话有独立的步数和工具预算，历史消息只作为上下文。面向用户的执行轨迹（模型开始/公开文本、工具开始/完成/失败、审批）随 checkpoint 持久化，并通过 Fetch + SSE 流即时送达界面；不展示模型的私有推理链。

写入工具默认需要审批；“完全批准”是当前用户、当前任务和当前文档内的显式自动执行授权，而非绕过 revision、校验或不可变版本。多处确定的文字改动用 `apply_text_changes` 先完整校验、再一次 mutate/validate/commit，保证全成或全不成。

旧四步 AgentRuntime 只作为兼容事务执行器，不能继续作为语义路由器。

## 参考与取舍

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)：参考 Agent Loop、tools、HITL、guardrails 和 tracing；未直接引入，以保留 DeepSeek/自托管 OpenAI-compatible 模型和 PaperDuck 版本事务的独立性。
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 与 [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)：参考 checkpoint、恢复和人工中断；不建立固定 graph，避免把产品流程重新写成状态路由。
- [AgentScope](https://doc.agentscope.io/)：参考 ReAct、工具事件和 session 思想；其 Python 运行时与当前 TypeScript 全栈不匹配。
- [Pi agent core](https://github.com/mudrii/pi-mono-docs/blob/main/03-pi-agent-core.md)：参考小核心、可组合工具和事件；PaperDuck 额外保留租户、文档 revision、MIME/对象存储和权限边界。
- [Vercel AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) 与 [OpenAI Agents SDK streaming](https://openai.github.io/openai-agents-js/guides/streaming/)：采用工具生命周期、流式事件和审批即运行状态的交互模型；不把 PaperDuck 的 CAS 文档事务交给通用框架执行。

## 迁移顺序

先提供只读 `inspect_document`、`list_document_regions`、`read_document_region`，再接入需要批准的 `apply_text_change`，最后把图片候选、版本恢复和导出迁移为同一工具注册表。每一阶段都必须有真实 DOCX round-trip 和失败恢复测试。
