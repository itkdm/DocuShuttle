# PaperDuck 生产发布手册

## 目标拓扑

Cloudflare 只负责 DNS、TLS 和边缘防护；Vercel 托管 Next.js；Supabase 提供匿名 Auth、Postgres 和私有 Storage。应用代码不依赖 Cloudflare Worker，因此暂不增加重复的边缘运行时。

## 发布顺序

1. 在 Supabase production 项目按文件名顺序应用 `supabase/migrations/`，确认迁移列表与仓库一致。
   当前 Agent Loop 额外要求 `202608260009_agent_loop_document_commit.sql`，其中包含 Agent 写入版本的 CAS 提交和审批 claim RPC；未应用该迁移时只能运行只读 Loop，审批写入会被安全拒绝。
2. 在 Vercel 绑定 GitHub 仓库 `itkdm/DocuShuttle`，Root Directory 保持仓库根目录，Framework 选择 Next.js，生产分支使用 `main`。
3. 配置下列 Production 环境变量，然后触发一次全量重新部署：

   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `DEEPSEEK_API_KEY`
   - `DEEPSEEK_BASE_URL`
   - `DEEPSEEK_MODEL`
   - `APIMART_API_KEY`
   - `APIMART_BASE_URL`
   - `APIMART_IMAGE_MODEL`
   - `NEXT_PUBLIC_APP_URL`（最终 HTTPS 域名）

   文本模型必须提供 OpenAI-compatible Chat Completions 地址；DeepSeek 使用 `DEEPSEEK_BASE_URL=https://api.deepseek.com`，也可以替换为 OpenAI 或自托管兼容网关。不要配置 Anthropic API 变量。

   任何 service-role、DeepSeek、APIMart 密钥都只能配置在 Vercel server-side 环境变量中，不能以 `NEXT_PUBLIC_` 开头，也不能提交到 Git。

4. 在 Cloudflare DNS 中为最终子域名添加指向 Vercel 的 CNAME（代理状态按 Vercel 域名验证要求配置），再在 Vercel 项目中绑定该域名。
5. 发布后检查：

   - `GET /api/health` 返回 `ok: true`，并确认 `configured` 与生产配置一致。
   - 上传真实 DOCX，确认私有 Storage、source file、Working Document 和版本记录均产生。
   - 导出并重新打开 DOCX，检查无修复提示。
   - 查看 Vercel runtime logs 与 Supabase advisors。
   - 普通对话：发送不涉及文档的问题，确认 Agent 直接回答且不调用工具。
   - 工具对话：发送“先检查文档，再修改某个区域”，确认先出现 inspect/read 工具事件，再出现带 nodeId、revision 的审批卡；批准后只产生一个新版本，拒绝后版本不变。
   - 刷新页面：确认 Agent Loop checkpoint、待审批调用和对话仍可恢复。

## 回滚

应用回滚使用 Vercel 上一个 READY deployment；数据库迁移只追加不回退。文档版本恢复使用应用内 `restore` 产生新版本，不删除历史版本。

## 当前状态

本仓库已通过本地 lint、typecheck、Vitest 和 Next production build。浏览器页面 E2E 的测试定义已提交，但本地未安装 Playwright Chromium，因此当前只运行 API/测试发现验证；部署完成后应在具备浏览器的 CI 或 DevTools 环境执行完整验收矩阵。

## 需要用户手动完成的控制台步骤

本机没有 Vercel/Supabase CLI 登录态，也没有 Cloudflare DNS 写权限，因此以下动作不能安全代办：

1. Supabase SQL Editor：按顺序执行未应用的迁移，特别确认 `202608260009_agent_loop_document_commit.sql` 中的两个 RPC 创建成功。
2. Supabase Authentication：启用匿名登录；Storage 创建私有 `paperduck-private` bucket，并确认 RLS policy 与迁移一致。
3. Vercel：导入 `itkdm/DocuShuttle`，生产分支选 `main`，配置上方 Production 环境变量并重新部署。
4. Cloudflare：将目标子域名 CNAME 指向 Vercel 分配的域名；在 Vercel Domains 中绑定同一子域名并等待 HTTPS 生效。
5. 将部署 URL 和一次真实匿名登录/上传测试结果提供给我，我再继续做 API/导出/恢复验收；浏览器验收按你的要求暂时不执行，最后单独报告。
