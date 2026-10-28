# AI 首批 8 个信源：一次性小样本采集与筛选验证

日期：2026-10-28（北京时间）。本阶段状态：验证完成，当时新增来源继续禁用，未发布或推送。

本文记录启用前的一次性验证时点；后续部分来源已按使用者授权启用，见[当日运营汇总](2026-10-28-operations-summary.md)。

## 结论

共读取 23 条样本，正文与可信日期均可取得；9 条通过本轮采用的预筛与双评分入选规则，14 条未入选（其中 0 条在相关性预筛阶段拦截）。DeepSeek 在最近 30 天窗口内只有 2 条，其他来源各 3 条。入选是本次独立验证的规则结论，不代表已生成网站内容或已发布。

## 验证时的后台配置与执行边界

- 正式 AI/default 频道 9 个信源均已核对为 180 分钟；开始本轮时它们已是该值，未做重复修改。原有 a16z 保持启用，新增 8 个保持禁用；未改安全频道。
- 将 a16z 遗留的旧下一次调度时间对齐为上次采集后 180 分钟；修改留存后台审计，具体运行调度值不纳入公开附件。禁用来源不参与持续调度。
- 新增来源正式首次回灌设置仍为每源最多 5 条、最近 1 个月；本轮仅在内存中把验证上限缩到 3 条。月份范围按现有采集器的 30 天计算。
- 一次性使用现有免费列表和正文读取函数，再调用正式预筛与两次独立评分；未执行 collectSource、文章入库、摘要写作、归组、发布或消息队列任务。后台新增来源的 fetch_runs、articles、publications 均为 0，因此后台“最近采集”仍为空，验证明细在本报告。
- 所有模型请求均经现有回执和平台/频道预算；触及每分钟 10 次额度后等待窗口续跑，未提高额度，未为超时未知结果盲目重发。来源开关、推送开关、模型和门槛都未修改。
- 正文提取明确关闭付费兜底。正文长度仅说明取到文本，不保证逐段完整；日报、翻译、事件归组和推送不在本轮验收范围内。

## 评分口径

- 模型：`deepseek/deepseek-flash`；预筛 `prefilter@20eab36cc7`，评分 `selection-score@e55fa3b5de`。
- T1 门槛 60，T2 门槛 76。非 BLOCK 样本两次评分之和达到两倍门槛即通过；展示分为两次分数均值向下取整。预筛拦截不再评分，不把未评分记为 0 分。
- 没有人工标注集，不能由这 23 条样本推算准确率、召回率或长期入选率，也未据此改动评分标准。

## 分来源汇总

| 信源 | 分级 | 样本 | 正文/日期 | 展示分 | 规则入选 |
| --- | --- | ---: | --- | --- | ---: |
| Anthropic News | T1 | 3 | 3/3；3/3 | 62、58、82 | 2 |
| DeepSeek 官方更新日志 | T1 | 2 | 2/2；2/2 | 65、71 | 2 |
| Google DeepMind | T1 | 3 | 3/3；3/3 | 81、58、58 | 1 |
| 上海人工智能实验室 | T1 | 3 | 3/3；3/3 | 25、71、78 | 2 |
| 量子位 | T2 | 3 | 3/3；3/3 | 30、88、22 | 1 |
| MIT News · AI | T1 | 3 | 3/3；3/3 | 18、12、12 | 0 |
| 极客公园 | T2 | 3 | 3/3；3/3 | 72、78、58 | 1 |
| The Decoder | T2 | 3 | 3/3；3/3 | 71、73、40 | 0 |

## 逐条结果

标题为便于审阅的概述，链接指向原文。只有日历日期的来源保留日期精度，不补造时分；其余时间转换为北京时间。正文字符数为该条评分使用的文本长度，少量配额续跑样本由原文页重读，证据同时保留首次采样长度。

| 来源 | 样本概述 | 发布日期/时间 | 正文字符 | 预筛 | 两次评分 | 展示分 / 门槛 | 入选 |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| Anthropic News | [Claude 药物研发合作进展](https://www.anthropic.com/research/early-progress-drug-development) | 2026-10-27 | 11,588 | PASS | 62/62 | 62 / 60 | 是 |
| Anthropic News | [Claude 与美国 GSA 扩大政府合作](https://www.anthropic.com/news/expanding-partnership-gsa) | 2026-10-27 | 3,967 | PASS | 58/58 | 58 / 60 | 否 |
| Anthropic News | [Anthropic 提交 IPO 注册文件](https://www.anthropic.com/news/s1-sec) | 2026-10-26 | 1,467 | PASS | 82/82 | 82 / 60 | 是 |
| DeepSeek 官方更新日志 | [DeepSeek 搜索 API 开放](https://api-docs.deepseek.com/zh-cn/updates/#开放自研搜索-api) | 2026-10-17 | 217 | PASS | 58/72 | 65 / 60 | 是 |
| DeepSeek 官方更新日志 | [DeepSeek V4.1 Flash 更新](https://api-docs.deepseek.com/zh-cn/updates/#deepseek-v41-flash-1017-更新) | 2026-10-17 | 761 | PASS | 71/72 | 71 / 60 | 是 |
| Google DeepMind | [Genie 4 世界模拟模型](https://deepmind.google/blog/genie-4-a-new-generation-of-world-simulation/) | 10-28 00:01 | 11,998 | PASS | 79/84 | 81 / 60 | 是 |
| Google DeepMind | [AI 森林类型制图研究](https://deepmind.google/blog/beyond-tree-cover-mapping-the-worlds-forest-types/) | 10-22 22:30 | 8,528 | PASS | 58/58 | 58 / 60 | 否 |
| Google DeepMind | [Antigravity 辅助抗菌肽研究](https://deepmind.google/blog/accelerating-antimicrobial-discovery/) | 10-16 00:08 | 7,162 | PASS | 58/58 | 58 / 60 | 否 |
| 上海人工智能实验室 | [上海 AI 实验室赛事与产学研合作](https://www.shlab.org.cn/news/5444310) | 2026-10-27 | 2,847 | PASS | 22/28 | 25 / 60 | 否 |
| 上海人工智能实验室 | [书生 A1.5 智能体自我改进](https://www.shlab.org.cn/news/5444309) | 2026-10-26 | 3,082 | PASS | 72/71 | 71 / 60 | 是 |
| 上海人工智能实验室 | [书生衍金辅助钛合金设计](https://www.shlab.org.cn/news/5444308) | 2026-10-21 | 2,362 | PASS | 78/78 | 78 / 60 | 是 |
| 量子位 | [钛动 Navos Pro 产品发布](https://www.qbitai.com/2026/10/505580.html) | 10-27 11:23 | 3,372 | PASS | 38/22 | 30 / 76 | 否 |
| 量子位 | [量子位解读 Anthropic 招股书](https://www.qbitai.com/2026/10/505551.html) | 10-27 00:06 | 7,913 | PASS | 88/88 | 88 / 76 | 是 |
| 量子位 | [天禧 AI 跨端协同体验活动](https://www.qbitai.com/2026/10/505539.html) | 10-26 17:46 | 2,179 | PASS | 22/22 | 22 / 76 | 否 |
| MIT News · AI | [MIT 机器听觉研究](https://news.mit.edu/2026/making-machines-that-can-listen-paris-smaragdis-1028) | 10-28 12:00 | 9,489 | PASS | 18/18 | 18 / 60 | 否 |
| MIT News · AI | [MIT 学习者合作编写 AI 书籍](https://news.mit.edu/2026/learner-prabha-jha-collaborates-with-mit-peers-to-develop-book-of-ai-insights-1027) | 10-28 04:55 | 6,591 | PASS | 12/12 | 12 / 60 | 否 |
| MIT News · AI | [MIT 纽约气候周交流活动](https://news.mit.edu/2026/at-new-york-climate-week-mit-connects-global-network-1026) | 10-27 03:00 | 7,249 | PASS | 12/12 | 12 / 60 | 否 |
| 极客公园 | [iPhone 屏幕问题报道](http://www.geekpark.net/news/373008) | 10-27 17:24 | 4,319 | PASS | 72/72 | 72 / 76 | 否 |
| 极客公园 | [极客公园分析 Anthropic 商业策略](http://www.geekpark.net/news/373006) | 10-27 16:55 | 4,169 | PASS | 78/78 | 78 / 76 | 是 |
| 极客公园 | [Manus 2.0 动态](http://www.geekpark.net/news/373004) | 10-27 16:49 | 4,501 | PASS | 58/58 | 58 / 76 | 否 |
| The Decoder | [研究者报告 Qwen 请求路由行为](https://the-decoder.com/alibabas-latest-qwen-models-routed-some-requests-through-company-servers-researchers-find/) | 10-28 03:45 | 4,677 | PASS | 74/68 | 71 / 76 | 否 |
| The Decoder | [Genie 4 与早期智能体设计的关系](https://the-decoder.com/google-deepminds-genie-4-puts-a-modern-spin-on-agent-designs-that-predate-llms/) | 10-28 01:25 | 3,434 | PASS | 74/72 | 73 / 76 | 否 |
| The Decoder | [前 DeepMind 研究者谈缓解幻觉方法](https://the-decoder.com/former-deepmind-researcher-thinks-alphagos-playbook-can-cure-ai-hallucinations/) | 10-27 21:55 | 5,939 | PASS | 38/42 | 40 / 76 | 否 |

## 结果留档

[公开验证摘要](evidence/2026-10-28-ai-small-sample-results.json)保留原文链接、日期精度、正文长度、预筛与双评分结果和门槛，不包含文章全文、凭据、配置快照哈希或回执编号。模型请求的用量与回执明细仅保留本机。

## 后续运行注意

框架仍保留每日 04:20 的自动采集间隔调整：它会对启用来源按产出重算频率，因此本次核验的 180 分钟是验证时的后台设置，不是新增“永久固定频率”机制。新增 8 个禁用来源暂不受该任务影响，a16z 后续可能被重算；本次未修改共享调度机制。

本报告只证明所取样本可读取和本轮规则能给出结果，不代表已经完成持续采集、模型质量校准或业务上线验收。
