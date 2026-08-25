# 纸上鸭 PaperDuck

纸上鸭是一个 Agent-first、Document-native 的 Word 文档智能体。用户提供 DOCX 模板、完成示例或两者，Agent 在真实 Working Document 上理解结构、提出修改计划、等待必要确认、生成并应用文本/表格/图片、自动校验、保留版本，最终导出高保真的 DOCX。

> 当前状态：架构已确认；SuperDoc 因真实文档硬门槛失败被拒绝为权威内核，项目采用自研 OOXML Preservation Kernel。历史远程方案不是本仓库的技术依据。

## 产品原则

- 文档是事实主体，Agent 对话是控制面。
- 所有 Agent 写入可预览、可确认、可追踪、可恢复。
- 原始 DOCX 永不原地覆盖；每次成功写入产生不可变版本。
- 高保真以可验证的 OOXML、重开兼容和视觉基线定义，不承诺不可测的“100% 一致”。
- 第一阶段只支持 `.docx`；旧 `.doc` 文件不在 MVP 范围。

## 已确认目标架构

```text
Cloudflare DNS / Edge
          │
          ▼
       Vercel
          │
   Next.js Fullstack
          │
 ┌────────┼───────────┐
 │        │           │
UI   Application   Server adapters
 │        │           │
 └──── Document Engine port
          │
 ┌────────┼──────────────┬──────────────┐
 │        │              │              │
Supabase DB + Storage    DeepSeek       APIMart
Auth/DB   private files  text/reasoning GPT Image 2
```

详细说明见：

- [产品需求](docs/product/prd.md)
- [系统架构](docs/architecture/system.md)
- [领域模型](docs/architecture/domain-model.md)
- [Agent 运行时](docs/architecture/agent-runtime.md)
- [验收标准](docs/testing/acceptance.md)
- [架构决策记录](docs/adr/README.md)

## 尚未阻塞开发、但上线前需要确认

1. 最终生产子域名：默认建议 `paperduck.itkdm.com`。
2. Supabase 项目名称和区域：默认建议项目名 `paperduck-production`，选择离主要用户最近且满足 Vercel 到数据库延迟的区域；项目创建前会核对费用。
3. 最终开源许可证：等待 Document Engine 实测决策后确定。

除此之外，当前产品、工程和安全默认值由项目规则自主收敛，不需要逐项等待确认。
