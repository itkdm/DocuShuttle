# ADR-0007：Agent 运行期允许预写提示词但禁止发送

状态：Accepted
日期：2026-08-27

## 背景

右侧 Agent 对话区（composer）在 Agent 运行期间（`stage === "analyzing"` 或等待确认/审批的 `stage === "awaiting"` 且非 `ask_user` 反问）原本把输入框、权限下拉和发送按钮一并禁用。

但这与用户的真实心智不符：Agent 执行分析或写入时，用户往往需要利用等待时间**提前构思并写下一条提示词**，等 Agent 就绪后再发送。把输入框整块锁死会打断思路，且降低"随时可继续对话"的体验。

## 决策

Agent 运行期间：

- **输入框（textarea）保持可写**。仅当未打开文档（`!workspaceReady`）时禁用。运行期只改变占位提示，引导用户「可先输入下一条提示词」。
- **发送仍被禁止**。回车与发送按钮由 `inputBlocked` 拦截：`submit()` 首行 `if (inputBlocked || !workspaceReady) return;`；发送按钮保持 `disabled`。
- **权限下拉（CustomSelect）在运行期仍禁用**，因为运行中切换权限语义无确定落点。
- 例外保留：当 Agent 处于 `ask_user` checkpoint（`awaitingUserQuestion === true`）时，输入框本就可写、可发送，用于回答 Agent 的反问。

实现位置：`src/components/workbench/agent-panel.tsx` 中 `inputBlocked` 计算与 composer 渲染。

## 后果

- 用户可在 Agent 跑批时预编排下一条指令，发送在 Agent 回到可交互状态后自动恢复可用。
- 运行期不会产生"用户文字被吞"或"误触发新 run"的风险，因为发送路径有 `inputBlocked` 兜底。
- 后续如引入"排队发送"（跑完自动提交预写内容），可在此基础上扩展，不影响本决策。
