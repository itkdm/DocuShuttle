# 多模态 Provider 边界

Language/Vision 使用 Provider-neutral 的 OpenAI-compatible Chat 语义：文本、
`image_url`/image content、Tool Calling 和 continuation 由 Infrastructure adapter
转换。业务层只依赖 `ImageVisionPort` 与结构化视觉事实，不分支判断具体供应商。

图片只在服务端从 private Storage 读取为短生命周期 bytes，Vision Tool 不返回 bytes、
Base64、signed URL 或 object key；checkpoint、EventStore 和日志只保留安全 metadata
与结构化分析。Qwen 是 capability profile 为 `vision=true` 的适配器，DeepSeek 与
generic OpenAI-compatible 默认 `vision=false`，未知 Provider 保守处理。

Image Generation 未来采用 provider-neutral 的 OpenAI Images-style normalized request，
包含 prompt、count、size、quality/resolution 和内部 reference image 引用。APIMart
的 task/polling、Wan native 参数等只存在于 adapter，不进入 Domain/Application；本轮
不改现有图片生成闭环。
