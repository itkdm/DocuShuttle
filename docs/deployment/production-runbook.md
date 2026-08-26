# PaperDuck 生产发布手册

## 目标拓扑

Cloudflare 只负责 DNS、TLS 和边缘防护；Vercel 托管 Next.js；Supabase 提供匿名 Auth、Postgres 和私有 Storage。应用代码不依赖 Cloudflare Worker，因此暂不增加重复的边缘运行时。

## 发布顺序

1. 在 Supabase production 项目按文件名顺序应用 `supabase/migrations/`，确认迁移列表与仓库一致。
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

   任何 service-role、DeepSeek、APIMart 密钥都只能配置在 Vercel server-side 环境变量中，不能以 `NEXT_PUBLIC_` 开头，也不能提交到 Git。

4. 在 Cloudflare DNS 中为最终子域名添加指向 Vercel 的 CNAME（代理状态按 Vercel 域名验证要求配置），再在 Vercel 项目中绑定该域名。
5. 发布后检查：

   - `GET /api/health` 返回 `ok: true`，并确认 `configured` 与生产配置一致。
   - 上传真实 DOCX，确认私有 Storage、source file、Working Document 和版本记录均产生。
   - 导出并重新打开 DOCX，检查无修复提示。
   - 查看 Vercel runtime logs 与 Supabase advisors。

## 回滚

应用回滚使用 Vercel 上一个 READY deployment；数据库迁移只追加不回退。文档版本恢复使用应用内 `restore` 产生新版本，不删除历史版本。

## 当前状态

本仓库已通过本地 lint、typecheck、Vitest 和 Next production build。浏览器页面 E2E 的测试定义已提交，但本地未安装 Playwright Chromium，因此当前只运行 API/测试发现验证；部署完成后应在具备浏览器的 CI 或 DevTools 环境执行完整验收矩阵。
