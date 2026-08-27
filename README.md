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
- [OOXML 内核覆盖率](docs/architecture/ooxml-kernel-coverage.md)
- [Agent 运行时](docs/architecture/agent-runtime.md)
- [验收标准](docs/testing/acceptance.md)
- [架构决策记录](docs/adr/README.md)

## 当前交付状态

- 自研 OOXML Preservation Kernel 已通过工作区 4 份真实 DOCX 的 no-op、两轮单元格修改、重开和结构诊断回归。
- Agent 已支持多区域原子生成；派生对象在 validate 重新打开通过后才晋级 current；拒绝提案会创建可审计恢复版本。
- 图片候选已通过 APIMart 生成并保存到私有 Storage；用户确认后可按稳定图片 `nodeId` 生成经过重开校验的 Working Document 新版本。
- Supabase production 已应用至 `example_seed_semantics`、`agent_validation_promotion_and_review_rollback` 迁移。
- 远程 `main`/`master` 已同步到最新提交；Vercel 已创建生产部署，但当前仍受团队 Deployment Protection 保护，尚未绑定最终自定义域名。

## 上线前需要手动完成

1. 在 Vercel 团队 `itkdm's projects` 的 `paperduck` 项目中配置 `.env.example` 列出的 Production 环境变量，并重新部署。
2. 关闭 Deployment Protection，或创建可供验收使用的临时 bypass；否则外部请求只会看到 Vercel 登录页。
3. 将最终生产域名（默认 `paperduck.itkdm.com`）添加到 Vercel 项目，再在 Cloudflare DNS 添加对应 CNAME 并开启 HTTPS。
4. 最终开源许可证仍需产品决定；Document Engine 本身没有迫使项目采用 copyleft 的依赖理由。

除此之外，当前产品、工程和安全默认值由项目规则自主收敛，不需要逐项等待确认。
