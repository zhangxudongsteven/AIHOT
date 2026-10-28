# Node.js 与 Spring 安全信源接入

2026-10-28，Asia/Shanghai。按使用者“先把能简单接入的接入了”的授权，在 myhot-lan 运行环境的 security 频道新增两个官方来源；未改动框架代码、评分门槛或环境总开关。

本文记录该次接入与首采时点，不代表长期稳定性或精选质量已经验收；与 AI / 论文来源的范围区别见[当日运营汇总](2026-10-28-operations-summary.md)。

可复用配置：[security-developer-sources.json](../examples/sources/security-developer-sources.json)。该文件 enabled=true，apply 会创建启用来源，不是禁用候选清单；仅在显式指定目标频道并确认运行环境时使用。

- Node.js：安全专用 RSS `https://nodejs.org/en/feed/vulnerability.xml`，现有解析器读出 77 条；前两条官方页面正文提取成功，最新样本 10542 字符。
- Spring：`https://spring.io/security/`，现有 HTML 列表解析器读出 25 条，日期保留日精度。未采用 Atom：实测前两条 Atom 的 content 只有漏洞描述，现有规则却会判为完整正文，缺少修复版本。网页列表要求后续抓取完整公告，样本正文 1275 字符，含受影响版本与修复表。
- 两者均为 T1、editorial、60 分钟检查，首次限量 3 条；站内和 RSS 全文展示关闭，owner 留空，未新增机构配置。
- 使用现有 planSourceIntake、previewSource 校验与预览，再通过 space-sources.ts apply 创建；两条均创建成功，操作者与完整审计仅留本机。
- 首次 collectSource：Node.js found=77/created=3，Spring found=25/created=3；两源 enabled=true、health=ok、last_error=null。
- 首次历史导入沿用平台回灌与旧文规则，不作为当天新公告。后续处理走原有 worker；本次未手工调用模型、付费正文兜底或消息发送。

未接入 GHSA、Tomcat 和 Oracle，它们需要分页、增量或结构化公告拆分等后续工作。本次 Spring 采集仅覆盖页面返回的 25 条，不宣称历史公告全量覆盖；未验证长期运行稳定性或精选质量。无应用代码改动，验证采用真实订阅解析、公告正文读取、管理层预览与首次采集，不运行全套回归。
