# 多模态 Provider 边界

Language/Vision 使用 Provider-neutral 的 OpenAI-compatible Chat 语义：文本、
`image_url`/image content、Tool Calling 和 continuation 由 Infrastructure adapter
转换。业务层只依赖 `ImageVisionPort` 与结构化视觉事实，不分支判断具体供应商。

图片只在服务端从 private Storage 读取为短生命周期 bytes，Vision Tool 不返回 bytes、
Base64、signed URL 或 object key；checkpoint、EventStore 和日志只保留安全 metadata
与结构化分析。Qwen 是 capability profile 为 `vision=true` 的适配器，DeepSeek 与
generic OpenAI-compatible 默认 `vision=false`，未知 Provider 保守处理。

Image Generation 使用 provider-neutral 的 normalized request：prompt、size、quality 和
临时 reference bytes。Provider 暴露 capabilities，并通过 submit/poll 分离异步生命周期；
APIMart 的 task/polling 与 data URL 适配只存在于 adapter。Agent 生成结果先进入 private
Storage 与 durable image_generation_jobs，再由 replace_document_image 在审批、Effect
Receipt、CAS 后创建不可变 Document Version。job 只保存安全请求摘要、hash、provider task
id 和资产引用，绝不保存 bytes、base64、URL 或 object key。
