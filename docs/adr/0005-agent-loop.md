# ADR 0005：PaperDuck 的模型驱动 Agent Loop

状态：Accepted  ���
日期：2026-08-26

## 决策

PaperDuck 自研一个 provider-neutral 的 Tool Loop，模型通过 OpenAI-compatible Chat Completions 适配器返回文本、工具调用或用户中断。工具由应用层注册并用 Zod 校验；文档工具只能通过 Document Engine、不可变版本和 revision CAS 产生副作用。

Loop checkpoint 暂存于 `agent_runs.state.loopCheckpoint`，并采用乐观锁；后续可以迁移到专用 checkpoint 表而不改变领域接口。旧四步 AgentRuntime 只作为兼容事务执行器，不能继续作为语义路由器。

## 参考与取舍

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)：参考 Agent Loop、tools、HITL、guardrails 和 tracing；未直接引入，以保留 DeepSeek/自托管 OpenAI-compatible 模型和 PaperDuck 版本事务的独立性。
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 与 [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)：参考 checkpoint、恢复和人工中断；不建立固定 graph，避免把产品流程重新写成状态路由。
- [AgentScope](https://doc.agentscope.io/)：参考 ReAct、工具事件和 session 思想；其 Python 运行时与当前 TypeScript 全栈不匹配。
- [Pi agent core](https://github.com/mudrii/pi-mono-docs/blob/main/03-pi-agent-core.md)：参考小核心、可组合工具和事件；PaperDuck 额外保留租户、文档 revision、MIME/对象存储和权限边界。

## 迁移顺序

先提供只读 `inspect_document`、`list_document_regions`、`read_document_region`，再接入需要批准的 `apply_text_change`，最后把图片候选、版本恢复和导出迁移为同一工具注册表。每一阶段都必须有真实 DOCX round-trip 和失败恢复测试。
