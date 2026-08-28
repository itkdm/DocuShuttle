# ADR 0008：Agent Runtime 不包含 Final Review

状态：Accepted
日期：2026-08-28

## 决策

Agent Runtime 的人工交互只包含 Tool Approval 与 `ask_user` 的 `user_input`。
写入通过 Document Engine、OOXML 重开校验、revision CAS 和 immutable version 后，
Agent Run 直接进入 `completed`。版本历史与 Restore 是当前的写入后安全机制。

## 原因

- Runtime 已经有 pre-write Tool Approval；
- `full` permission 不应被强制的第二次确认破坏；
- immutable version 与 Restore 已提供写入后的恢复能力；
- Final Review 没有当前 Agent Runtime 所需的 durable product semantics。

如果未来需要版本验收、人工发布审核或评论，应作为独立的 Document Version / Artifact
Workflow 设计，而不是把版本审核重新放回 Agent 生命周期。
