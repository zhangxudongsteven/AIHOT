# 上游更新与整合评估

评估日期：2026-10-28（Asia/Shanghai）。范围是检查更新、分析冲突与验证临时整合方案；没有在本项目合入上游代码、提交、发布或启用外发。

## 后续结项补充（2026-10-28）

六个修复已在本项目提交 `25a57c6`，经 [PR #5](https://github.com/zhangxudongsteven/AIHOT/pull/5) 合入 `main`，合并提交为 `9d771cc`。本页其余部分保留评估时点的结论与验证限制，不应据此判断六个修复仍未整合或尚缺完整测试；实际适配、Node 24 完整验证及真实样本比较见[六个上游修复的本地整合](2026-10-28-upstream-six-fixes.md)。飞书告警功能仍另行安排，源码合并不等于部署发布。其他当日工作见[运营汇总](2026-10-28-operations-summary.md)。

## 评估时的结论

建议选择性引入 **6 个正确性修复**，将 **1 个飞书告警功能提交**单独安排。继续遵守独立 fork 的维护方式，不用整体同步替代逐项评审。

这批更新没有数据库迁移、依赖升级或公开协议变化。整合的主要代码工作是解决 3 处 Web 冲突，同时保留本项目的频道路由及发布时间精度；主要验证工作是采集行为的真实样本比较和完整集成测试。

## 核验基线与来源

| 项目 | 固定值 |
| --- | --- |
| 来源仓库 | [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) |
| 上游最新 main | [`79d962ea96c7f2ed0d2df9b01d9cf00b5550d1d0`](https://github.com/KKKKhazix/AIHOT/commit/79d962ea96c7f2ed0d2df9b01d9cf00b5550d1d0)，提交时间 2026-10-27 18:16:31 +08:00 |
| 本地 main | `5ddd590f0e214d4a0b1ca26fe5b3cc89e8243ef2` |
| 共同祖先 / 已记录上游基线 | `b3998dc6fc138eb9659f33f55eb38c1c716f0d57` |
| 分叉后的提交数 | 本项目 18 个，上游 7 个；均按可达提交计数，包含本项目 merge commits |
| 上游改动 | 17 个文件，321 行新增、28 行删除 |
| 两边共同编辑 | 11 个文件；Git 实际报告 3 个内容冲突 |

通过 GitHub 连接读取 main、提交列表、releases、开放 PR 和最新提交 checks，再在临时 Git 副本 fetch 固定 SHA。GitHub releases 查询为空，因此本次按源码提交评估。最新上游提交的 `check` 与 `docker` 检查均成功，但这不验证本项目整合结果。

两条固定比较为 `git diff b3998dc...79d962e` 与 `git diff b3998dc...5ddd590`，两轴评审使用同一组提交与差异。工作区原有未提交的 CHANGELOG 和信源报告未纳入固定代码比较，也未修改。

## 更新清单与取舍

| 上游提交 | 改动与本项目收益 | 建议 |
| --- | --- | --- |
| [`58168ec`](https://github.com/KKKKhazix/AIHOT/commit/58168ecb92c5911c35d501c4cb0c9a2c2bd6b257) | 事件日期、主题更新及日期戳在跨年时显示年份，减少历史内容歧义。 | 引入；保留本地仅日期条目的展示逻辑，手动解 Web 冲突。 |
| [`21e5c03`](https://github.com/KKKKhazix/AIHOT/commit/21e5c036b3f91cf8327d4ba3c03aa2282092488d) | 读取指定日期元素里的“2天前”“3 hours ago”，减少列表文章因无日期而无法公开的问题。 | 与后两个日期修复作为一个完整补丁组。 |
| [`ed4cbd1`](https://github.com/KKKKhazix/AIHOT/commit/ed4cbd1c2a874e43e455c6c4ad8f0bb89888f28d) | “47小时前”仍保留时刻；只有天单位降为日期精度。 | 不应遗漏，否则会带入前一个提交的中间行为。 |
| [`ce83484`](https://github.com/KKKKhazix/AIHOT/commit/ce8348477438cce2b417c1403290a511c812a7c5) | 支持“今天 15:46”、作者前缀、“16h ago”等常见形式。 | 日期组第三项，保持原提交顺序。 |
| [`aa8e5b1`](https://github.com/KKKKhazix/AIHOT/commit/aa8e5b1bc4895267f98abe59c87dfed8a22bf35f) | 平台运维告警可通过独立群机器人发送，减少对飞书应用接口的依赖；反馈截图继续使用应用。 | 独立整合；当前部署需要额外适配，不作为六个修复的前置条件。 |
| [`04427b9`](https://github.com/KKKKhazix/AIHOT/commit/04427b98d7f6fb3e56e58e8ef3cba6a7c6740a4c) | 日报切换、前后日期链接及跟进徽章补上跨年年份。 | 在 `58168ec` 的格式化 helper 基础上引入。 |
| [`79d962e`](https://github.com/KKKKhazix/AIHOT/commit/79d962ea96c7f2ed0d2df9b01d9cf00b5550d1d0) | 识别 Devise、WordPress 及带扩展名的登录地址，避免将登录页当正文或列表文章。 | 优先引入；补验扩展名后的路径边界。 |

上游已有的安全依赖修复 `b3998dc` 是共同祖先，已包含在本项目，无需再次引入。

## 实际冲突与兼容性

`git merge-tree --write-tree 5ddd590 79d962e` 返回 3 个冲突，临时副本中的实际无提交合并也重现相同结果：

| 文件 | 最小解决方式 |
| --- | --- |
| `apps/web/app/lib/format.ts` | 将 contracts 的 `monthDay` 别名为 `engineMonthDay`，加入上游基于北京时间当前年份的 wrapper；保留 `isValidDate`、`publicationValue`、`timelineValue`、`clockTime` 及所有仅日期分支。 |
| `apps/web/app/routes/story.tsx` | 改用 Web 格式化模块导出的 `monthDay`；保留 `space-router`、频道元信息及 `publicationValue`/`clockTime` 调用。 |
| `apps/web/tests/day-header-year.test.ts` | 保留双方行为用例，既验跨年，也验仅日期条目不凭空显示时分。 |

其余共同编辑文件可由 Git 自动合并，仍需验证行为。相对日期解析与本地已有 `PublicationDate` 返回契约一致：小时、分钟返回 ISO 时刻，天数返回来源时区的 `YYYY-MM-DD`。绝对日期属性和文本优先，只有失败后才尝试指定元素的相对文本，不扩大成任意正文或修改时间猜测。

相对时间每次推算会有误差，但既有文章的 `published_at` 不会随采集候选反复替换；内容哈希也不包含该候选时间。本批整合无需重评历史内容或重跑付费分析。首次读出的相对时间仍须结合真实来源样本验证。

## 飞书告警的部署边界

`aa8e5b1` 仍先检查 `FEISHU_INTERNAL_ENABLED === "true"`，然后优先使用 `FEISHU_ALERT_WEBHOOK_URL`，否则使用应用告警群或内部群。它是平台运维出口，符合 ADR 对平台 scope 的定义，无需接入频道内容订阅。

当前 `compose.lan.yml:40` 将内部通知固定为 `false`，后端环境白名单也没有传入新告警 webhook；Mac/LAN 私有配置模板和说明同样保持内部通知关闭。因此只合入上游代码不会使现有部署获得可用告警出口。

若后续需要该能力，应单独完成：

- 在后端环境白名单与私有配置模板中增加运维告警凭据，并明确允许内部通知的部署配置；Web 不接收凭据。
- 保持运维 webhook 与 AI、安全频道内容 webhook 的用途分离；反馈仍按既有应用机制处理。
- staging 继续强制关闭外发，并验证新环境项不会将真实凭据传入 staging 或 Web。
- 通过本地假服务验证关闭无请求、webhook 优先、应用回退、失败可观察、中文长文本拆分与限速，再安排实际部署验收。

## Standards

正式 findings：**0**；最高严重度：无。本轮未发现阻断整合的确证代码缺陷。没有数据库、依赖或公共协议变更；模型回执、预算入口和页面不调模型等边界未被改动。

有一项非阻断边界建议：上游 `content/extract.ts` 的 `AUTH_PATH` 扩展名分支未要求扩展名后为路径边界，`/login.php-guide`、`/auth.html5` 会被判断为登录页，而旧版不会。尚未发现当前真实信源命中；整合时宜增加这些负例，并收紧完整扩展名的结束条件，防止误排普通内容路径。

## Spec

正式 findings：**0**；最高严重度：无。需求依据为 `docs/fork-maintenance.md` 的逐补丁评审要求、`docs/adr/0001-multi-space.md` 的频道与平台 scope、现有发布时间精度契约及部署外发规则。

本地精度 helpers、频道 router 与安全阀必须在冲突解决中保留；临时候选已按此处理。现有 MS-002（历史译文）、MS-004（讨论帖配置版本）、MS-007（频道历史快照）不在这批修复范围，继续保持 Open。

## 已执行验证与限制

临时核验目录：`/private/tmp/aihot-upstream-review-20261028.Of1DHL`。无提交试合并目录：`/private/tmp/aihot-upstream-trial-20261028.DS8UwJ`。试验覆盖全部 7 个提交，以评估完整冲突面；推荐的第一批仍只选择 6 个修复。

- 三处冲突解决后，`git ls-files -u` 为空，`git diff --cached --check` 通过。
- 原有 Web 日期测试与新增日报测试 **10/10 通过**。
- 从既有 source-dates 测试原样复制 18 项不依赖正文提取的纯日期测试至临时文件，配合原有发布时间格式测试 2 项和上述 Web 10 项，在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下分别 **30/30 通过**；两次运行使用相同用例，不代表 60 项独立覆盖。
- 运行时为 Node **v26.7.0**；尚未在项目要求的 Node 24 环境复验。
- 主仓库没有安装依赖。尝试的完整来源、日期元素和登录路径测试中，4 个文件因缺少第三方包在导入阶段失败，未得到其行为验证结果。未安装依赖，未运行完整类型检查、构建、数据库告警测试或浏览器验收。
- Standards 补充检查还在内存中执行了上游相对日期和登录路径函数；这类提取验证不能替代真实模块及采集链路测试。

主要可复验命令（在试合并目录运行）：

```bash
node --test apps/web/tests/day-header-year.test.ts apps/web/tests/report-year.test.ts
TZ=UTC node --test trial-source-dates-pure.test.ts tests/source-published-formats.standalone.test.ts apps/web/tests/day-header-year.test.ts apps/web/tests/report-year.test.ts
TZ=Asia/Shanghai node --test trial-source-dates-pure.test.ts tests/source-published-formats.standalone.test.ts apps/web/tests/day-header-year.test.ts apps/web/tests/report-year.test.ts
```

以上结果足以支持整合方向和冲突解法，尚不构成可发布结论。

## 建议执行方案与验收

**第一批：六个修复。** 从本项目最新 main 新建 `codex/` 分支，选择性移植 `58168ec → 21e5c03 → ed4cbd1 → ce83484 → 04427b9 → 79d962e`，保留来源 SHA、署名与本地适配记录。按上文解决三个冲突；无需沿用整批上游 merge，也无需改动品牌、行业门槛、历史迁移或协议版本。

先做定向验证：发布时间精度、列表指定日期元素、来源时区、`47小时前`、作者前缀、今天时刻和短单位；登录导航/重定向与普通内容负例；默认及安全频道的事件、主题、日报跨年显示和仅日期条目。随后用一批公开真实订阅与网页对改动前后结果做比较，记录总条数、变化条数、每类变化是否正确，特别检查首次导入、48 小时归档边界、正文误收和旧文不重发。

准备提交时，在安装依赖且使用 Node 24 的环境对最终版本统一运行仓库要求的类型检查、隔离测试库后端测试、Web 构建及测试和站点 smoke。此前临时纯函数结果不替代这一轮验收。开发者日志记录本项目实际交付，读者可见变化同步站点日志，沿本项目版本发布。

**第二批：告警功能。** 需要运维机器人出口时，再单独移植 `aa8e5b1` 并完成部署白名单、配置模板、文档和假服务测试。上线启用与凭据配置属于实际部署工作，不随源码合并自动执行。

**暂缓：未合并的上游草稿。** 检查时只有 [PR #263：提供带原文与版本校验的全文译文导入入口](https://github.com/KKKKhazix/AIHOT/pull/263) 处于 open draft。它不属于最新 main 的 7 个提交；若未来需要外部译文导入，再额外评估本项目的频道、配置版本和处理代次归属，不能把它当作 MS-002 的现成修复。

评审计数：Standards 0，Spec 0；最高严重度均为无。评估时尚余上述完整验证与正式整合；六个修复的后续完成状态见页首结项补充，不以此历史结论推断部署状态。
