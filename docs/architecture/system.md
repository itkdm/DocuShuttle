# 系统架构

状态：Accepted，Document Engine 实现待 ADR 结论。

## 部署拓扑

Cloudflare 管理 `itkdm.com` DNS、HTTPS 边缘保护与必要限流；Vercel 承载 Next.js Fullstack；Supabase 提供 Auth、PostgreSQL、RLS 和私有 Storage；DeepSeek 提供文本推理；APIMart GPT Image 2 提供图片生成。

大文件不经过 Vercel Function 请求体转发，浏览器通过服务端授权的短时签名直接上传私有 Supabase Storage bucket。

文本模型通过 OpenAI-compatible Chat Completions 端口接入；DeepSeek、OpenAI 或自托管网关只由服务端 `*_BASE_URL`、`*_MODEL` 和密钥配置决定，不在 UI/领域层锁定供应商。上线前连接测试、普通对话、tool-call 往返和结构化输出回归属于发布门槛。

## 代码依赖方向

```text
React UI / Route handlers
          │
          ▼
 Application use cases
          │
          ▼
       Domain
          │
          ▼
        Ports
          ▲
          │
Supabase / AI / DOCX adapters
```

领域和应用层不得导入供应商 SDK。Route Handler 只负责鉴权、输入校验、调用用例和传输响应；Agent 编排、OOXML 操作、重试与版本提交不得塞入路由或 React 组件。

## 运行与一致性

- 数据库是任务状态真源；SSE 仅传输可重连事件。
- Agent 由可恢复模型驱动 Tool Loop 组成；每个 turn、tool call 和副作用都有幂等键与持久化 checkpoint。旧短步骤只保留为兼容事务边界，不负责决定语义流程。
- `working_documents.current_version_id` 通过 revision/CAS 乐观锁推进。
- 原始文件和版本文件位于私有 Supabase Storage；数据库只保存对象键、校验和、结构化状态和审计信息。
- 模型输出是不可信结构化输入，必须校验并限制到当前用户、任务和允许工具。
- 图片候选通过 `POST /api/tasks/:taskId/images` 进入独立的 Generation 用例：APIMart 只返回供应商结果，应用层将候选下载为受限 MIME/大小的二进制，写入私有 `assets` 对象并返回短时签名 URL。API 不暴露供应商密钥，也不把供应商 URL 当作持久化文档地址。
- 图片候选 DTO 可带 `targetNodeId`，但候选生成不会修改 Working Document；只有后续显式选择/确认步骤才能构造 `replace-image` 操作并进入 OOXML 版本提交。
- 图片候选确认通过 `POST /api/tasks/:taskId/images/:assetId/apply` 完成：服务端重新读取当前版本并按 `nodeId` 定位图片，校验候选归属、旧 revision、图片 fingerprint 和输出重开结果，再用 `commit_user_document_version` 原子创建 `origin=user` 新版本；任何冲突都不会切换 current version。

## 安全边界

- 匿名用户也使用真实 Supabase Auth `user_id`；所有用户表开启 RLS。
- API 从服务端会话推导 owner，绝不信任客户端提交的 `owner_id`。
- Storage object key 使用用户/任务前缀，服务端只签发短时受限 URL。
- 上传检查扩展名、MIME 签名、ZIP 解压大小/压缩比、外部关系和宏；MVP 拒绝 `.docm`。
- Provider 密钥只存在于服务端环境，不进入浏览器、数据库、文档或日志。

## 环境约束

TypeScript 端到端；Next.js App Router；生产部署不依赖 Docker。本地不启动 Docker 化 Supabase，开发和测试连接托管项目或使用确定性 adapter fake。固定付费许可证依赖必须先获得明确决策。
