# ADR-0001：生产平台与服务边界

状态：Superseded in part by ADR-0004
日期：2026-08-26

## 决策

原决策采用 Cloudflare → Vercel → Next.js Fullstack；Supabase 仅承担 Auth/PostgreSQL/RLS；Aliyun OSS 是唯一正式文件存储。文件存储部分已被 ADR-0004 取代，其余平台边界仍有效。

## 后果

- 放弃历史方案中的 Python/FastAPI、mammoth 核心预览、python-docx 核心写入和 Supabase Storage。
- 浏览器直传 OSS，避免 Vercel Function 大文件转发限制。
- 匿名体验仍有真实 user ID 与 RLS 隔离。
- 长任务不依赖单次请求或 SSE 连接存活。
- Document Engine 可在 SuperDoc 和自研实现之间替换。
