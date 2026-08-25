# Agent 运行时

## 状态机

```text
queued → analyzing → awaiting_scope_confirmation
                      │ approved
                      ▼
 generating → applying → validating → awaiting_review → completed
      │           │          │               │
      └───────────┴──────────┴───────────────┴→ failed / cancelled
```

失败 Run 可从最近 checkpoint 恢复，同一 `run_id` 和 cursor 继续；已经成功的 step 不重复副作用。等待确认时 Run 不占用持续连接或长函数执行时间。

## Step 合约

每一步记录输入/输出引用、状态、尝试次数、幂等键、开始/结束时间、错误分类和 redacted diagnostics。写步骤必须：校验 base revision、建立预写检查点、在临时对象上应用、验证输出、上传派生版本、原子推进 current version、发布事件。

## HITL

低风险单区域修改可生成内联建议；高风险/多区域任务生成只读计划。确认操作冻结 Decision，并从持久化 cursor 恢复。文档 revision 已变化时返回 409/conflict，重新定位和分析，不静默 rebase。

## 流式传输

Token 或进度事件只用于展示。前端刷新后从数据库状态和事件游标恢复。文档画布只在一个原子版本提交成功后更新，避免半写入 DOCX。
