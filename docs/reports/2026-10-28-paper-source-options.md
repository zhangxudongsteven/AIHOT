# AI 论文信源候选与可采集性

日期：2026-10-28（北京时间）。仅发现与读取验证；未向后台新增或启用来源，未调用模型、未推送。

本文保留论文来源发现阶段的候选结论；后续定向验证、试运行与 ACL 移除见[当日运营汇总](2026-10-28-operations-summary.md)。

## 优先顺序

| 优先级 | 来源 | 本环境实测 | 建议用途 |
| --- | --- | --- | --- |
| P0 | arXiv cs.CL | RSS 176 条、全部有可解析日期；抽查 1 个摘要页可读 | 语言模型、NLP、检索、评测等论文发现 |
| P0 | arXiv cs.AI | RSS 407 条、全部有可解析日期；抽查 1 个摘要页可读 | 智能体、规划、推理等论文发现 |
| P1 | arXiv cs.LG | RSS 437 条、全部有可解析日期；抽查 1 个摘要页可读 | 训练、优化、泛化、机器学习方法 |
| P1 | ACL Anthology | 官网可访问；未完成逐篇列表、日期及增量验收 | NLP 会议论文库；优先从官方元数据按会议/卷接入 |
| P2 | arXiv cs.CV | RSS 245 条、全部有可解析日期；抽查 1 个摘要页可读 | 关注视觉、多模态、视频时补充 |
| 待解决 | Hugging Face Daily Papers | 公开 JSON 接口在本环境超时 | 社区精选发现层，不能作为作者一手或同行评审证明 |
| 待解决 | OpenReview ICLR 2026 | API 返回 403 ChallengeRequiredError | 解决正式访问方式后核验论文状态、公开日期、评审与录用信息 |
| 待解决 | CVF CVPR 2026 | 全量目录超过现有响应大小限制 | 后续拆分会议日期/目录验证，不增加全局响应上限来硬抓 |

这些数量是当次 RSS 快照条目数，含新稿、跨分类和版本更新，不是去重后的每日新论文数，不能直接相加。摘要页可读不等于 PDF 或 HTML 论文全文已提取。

## 接入前需要处理的边界

1. 优先定向发现，不建议把四个 arXiv 分类全量送入现有模型流水线。现有频道限制为每分钟 10 次、每小时 100 次、每天 300 次；仅预筛加双评分就每条最多 3 次，正式摘要和归组还会增加请求。
2. 建议先选择 cs.CL 与 cs.AI 中的业务主题，再做每源最多 3 条的筛选验证；暂不自行决定正式关键词、评分标准或启用名单。论文来源可覆盖各国作者，不能把英文论文库视作只覆盖海外研究。
3. arXiv RSS pubDate 是论文/版本的公告时间，不一定是首次提交时间；新稿、替换稿和跨分类公告需要区分，不能把旧文更新都写成新论文。官方查询 API Atom 的 published 表示首版提交处理日期，updated 表示 API 所返回版本的日期；应按所需事件口径选字段。
4. 已额外实测官方 arXiv 查询 API：cs.CL 按 submittedDate 倒序、max_results=3 的 Atom 输出可由现有 RSS 解析器读取（详见证据）。这是验证用的小请求，不是生产限量方案：长期只取最新 3 条会漏掉轮询间的其余论文，生产需要先设计窄查询与完整增量/分页策略。
5. 现有 initialBackfillLimit 只限制首次导入，不是每天/每轮的文章上限；不能用设置首次 3 条来承诺长期只处理 3 条。降低采集频率也不会消除已有列表的新论文总量。
6. arXiv 收录不表示同行评审通过；OpenReview 投稿、录用、撤稿等状态分别核验。来源一手分级不应被理解为研究结论已经成立。
7. 不把摘要标记成论文全文，也不因能下载 PDF 就开启站内全文或全文分发。若之后要求核验实验、局限或基准，需要再读取论文全文。
8. 多个 arXiv 分类以及论文、机构博客、媒体报道会交叉覆盖。启用前核对 arXiv ID、版本号、DOI 和已有 URL 归一化行为，不把同一论文计为多个独立突破。

## 官方参考与证据

- [arXiv RSS 使用说明](https://info.arxiv.org/help/rss.html)
- [arXiv RSS 字段语义](https://info.arxiv.org/help/rss_specifications.html)
- [arXiv API 日期与查询说明](https://info.arxiv.org/help/api/user-manual.html)
- [ACL 官方数据访问方式](https://aclanthology.org/faq/api/)
- [OpenReview 字段与日期语义](https://docs.openreview.net/reference/api-v2/entities/note/fields)
- [Hugging Face 论文工具说明](https://huggingface.co/docs/huggingface_hub/main/en/guides/cli)
- [CVPR 2026 论文目录](https://openaccess.thecvf.com/CVPR2026)
- [本环境验证证据](evidence/2026-10-28-paper-source-probes.json)
