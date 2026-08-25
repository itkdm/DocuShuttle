# ADR-0004：文件存储统一到 Supabase Storage

状态：Accepted
日期：2026-08-26
取代：ADR-0001 中的 Aliyun OSS 文件存储部分

## 背景

原方案要求 Aliyun OSS 承载所有文件。真实连通性测试对目标 bucket 执行最小 PUT 探针时返回 `InvalidAccessKeyId`，现有凭据无法使用。继续保留两套对象存储会增加密钥、CORS、签名、RLS 映射和故障恢复复杂度，而第一阶段已依赖 Supabase Auth 与 PostgreSQL。

## 决策

正式文件存储使用私有 Supabase Storage bucket `paperduck-private`：

- 浏览器通过当前匿名/登录用户会话获得签名上传 URL，文件不经过 Vercel Function 转发；
- object key 固定为 `users/{user_id}/tasks/{task_id}/{category}/{file}`；
- bucket 级限制为 20 MiB、明确 MIME allowlist、默认私有；
- `storage.objects` RLS 同时校验 bucket、用户目录和 `owner_id`；
- 服务端以同一用户会话下载并验证 byte length、SHA-256、ZIP/OOXML 结构，验证通过后才原子登记 source 与初始 version；
- 数据库只保存 object key，不保存永久公开 URL；下载使用短时签名。

不在应用运行时使用 service-role，因此 Storage 与数据库都由同一租户 RLS 边界保护。

## 影响

优点是消除一套失效凭据和跨云权限映射，匿名 Auth、RLS、数据库与对象 ownership 一致。代价是文件与数据库位于同一供应商，迁移时需要通过现有 `PrivateObjectStoragePort` 增加新 adapter；领域与应用用例不依赖 Supabase SDK，保留未来迁移能力。
