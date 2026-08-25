# 领域模型

## 边界

- **Identity & Access**：匿名/升级用户、工作区、所有权和 RLS。
- **Documents**：源文件、Working Document、版本、结构节点、锚点、资产和导出。
- **Agent Runtime**：Run、Step、checkpoint、工具调用、幂等和使用记录。
- **Review**：Proposal、HITL Request、Decision、评论和冲突。
- **Generation**：供应商无关的文本/图片请求、结果、重试和成本。

## 最小持久化模型

`workspaces`, `tasks`, `source_files`, `working_documents`, `document_versions`, `document_manifests`, `assets`, `conversations`, `messages`, `agent_runs`, `agent_steps`, `hitl_requests`, `hitl_decisions`, `exports`。

`document_versions` 至少记录 parent、origin、Storage object key、SHA-256、engine/version、创建者和 run。大结构清单可在私有 Storage 保存，数据库保留索引和摘要。稳定 `node_id` 是逻辑身份，具体 OOXML 路径/偏移是某版本的地址，两者不能混为一谈。

## 关键不变量

- Source bytes immutable；Working Document 永远指向一个已校验版本。
- 每次写入生成新版本，恢复旧版也生成一个新的恢复版本。
- Proposal/Decision 绑定基础 revision；过期写入返回冲突。
- Run 状态、Document version 和 SSE connection 分离。
- 已完成幂等步骤重试时不得重复生成资产、收费、上传或创建版本。
