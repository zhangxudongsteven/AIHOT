# DeepSeek 开发联调记录（2026-10-23）

本机一次性进程通过腾讯云 TokenHub 国际站完成真实模型联调。使用现有 `chatJson → paidRequest → receipts/receipt_attempts` 链路，未启动 worker、采集信源或发送飞书消息；不代表完整内容流水线或服务器部署已验收。

## 配置修正

- 私有 `.env` 的 `LLM_BASE_URL` 原本包含完整 `/v1/chat/completions`，会与调用代码重复拼接；已修正为 `https://tokenhub-intl.tencentcloudmaas.com/v1`，与 [TokenHub 官方接口说明](https://www-sg.tencentcloud.com/zh/document/product/1300/80632) 一致。
- 保留用户配置的 `LLM_MODEL=deepseek/deepseek-flash`，实际调用确认该标识可用；API Key 未改动、未输出或写入报告。
- 保留已有频道的关闭思考参数，并将 `.env` 对齐为 `LLM_EXTRA_JSON={"thinking":{"type":"disabled"}}`。
- 复制当前频道配置，仅更新默认模型名称；成功验证后才激活新版本，其他业务规则、提示词及模型路由不变。
- 旧配置版本：`ff97dca704a4d7c4d897d98538b2404c0d2f6610000ca719c018435f3c575cd0`。
- 新配置版本：`836135eaea42b1b79e866afc946d9f9f8d19da343339d19751e6b0a4fac906b6`。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| Chat Completions 与 JSON 输出 | 通过；只发送合成公告，提取产品、修复版本、利用证据及中文摘要 |
| 内容约束 | 正确提取 `ExampleGateway`、`1.2.4`，没有把“发布更新”推断为“已发生在野利用” |
| 回执复用 | 完全相同的第二次调用返回同一回执，`reused=true`，无新增请求 |
| 频道配额 | 临时限制为 1 次后，不同输入在发送前抛出 `BudgetExceededError`，无新增 attempt |
| 用量 | 1 次真实请求；输入 137、输出 50、合计 187 tokens，推理 tokens 为 0 |
| 数据库回读 | `myhot` 开发库为 0 篇文章、1 条模型回执、1 条 attempt、0 条成功投递 |
| 配置激活 | 成功后读回活动版本，与验证版本一致 |

回执 ID 为 `1`，状态 `received`。合成结果未进入文章/报告发布流程，因此不伪造业务完成状态。没有绕开回执直接调用模型，也没有自动重试、备用模型调用或释放未知结果。

配额验证后，默认频道 `llm` 服务保留开发请求上限：每分钟 3 次、每小时 10 次、每滚动 24 小时 20 次，平台原有限额不变；这些是请求次数，不是 token 或金额限额。配置变更和配额更新均有审计记录。

## 运行边界

私有 `.env` 的采集、模型、内容推送、内部飞书通知和 IndexNow 五项开关仍为 `false`。仅验证进程临时设置 `MODEL_CALLS_ENABLED=true`，进程已退出。

`.env.lan`、`compose.lan.yml` 和部署脚本未启用模型或注入凭证，尚未验证远程 Docker 环境。没有更改应用实现或自动化测试，也没有将真实调用加入 `npm test`。

本机详细证据保存在被 Git 忽略的 `.data/deepseek-smoke-20261023/result.json`；同目录 `probe.mjs` 是带有空库前置断言的一次性验证脚本，不应直接重复执行。
