# 已知问题

登记日期：2026-10-23（Asia/Shanghai）。发现于本 fork DEV-01～DEV-05 变更，公开接口版本 4.1.0。

本页保留 review 确认的 7 项问题。2026-10-27 已将 MS-001、MS-003、MS-005、MS-006 修复归入源码版本 4.2.0（实现提交 [`e341acb`](https://github.com/zhangxudongsteven/AIHOT/commit/e341acb)），未部署线上；MS-002、MS-004、MS-007 仍 Open。以下原始复现与新增回归证据均来自隔离测试数据库或浏览器，不代表生产部署验证。最新范围见[双频道开发验证](reports/2026-10-27-ai-security-channels.md)。

| 编号 | 优先级 | 问题 | 状态 | 修复版本 |
| --- | --- | --- | --- | --- |
| MS-001 | P1 | 停用频道阻断全局恢复 | 已修复 / 未部署 | 4.2.0 · `e341acb` |
| MS-002 | P2 | 配置更新隐藏历史译文 | Open / 待后续版本修复 | 未定 |
| MS-003 | P2 | 周报订阅窗口漏推 | 已修复 / 未部署 | 4.2.0 · `e341acb` |
| MS-004 | P2 | 讨论帖重匹配使用错误配置版本 | Open / 待后续版本修复 | 未定 |
| MS-005 | P2 | 后台更正未传播到非默认频道报告 | 已修复 / 未部署 | 4.2.0 · `e341acb` |
| MS-006 | P2 | 单连接池导致迁移永久等待 | 已修复 / 未部署 | 4.2.0 · `e341acb` |
| MS-007 | P2 | 跨频道后退、前进丢失历史快照 | Open / 待后续版本修复 | 未定 |

## MS-001：停用频道阻断全局恢复

- **本地修复（2026-10-27）：** 回执核对仍提交；重置文章为可恢复状态后，停用频道不重新入队。共享锁保护启停与入队判断；重新启用可由正常 sweep 接续。`processing-recovery.test.ts` 覆盖停用频道与正常频道同批核对、无停用任务及重新启用恢复。
- **位置：** [jobs/content.ts](../packages/backend/src/jobs/content.ts) 的 `resumeAfterRelease()`（登记时第 320～324 行）；调用链见 [operations/recover.ts](../packages/backend/src/operations/recover.ts) 的 `release()`、`autoReleaseUnknownReceipts()` 和 `recoverStaleWork()`。
- **触发与复现：** 频道内文章因 unknown 回执进入失败状态，随后停用该频道，再执行自动释放。`resumeAfterRelease()` 调用 `queueProcessing()` 时，频道解析抛出 `Space is disabled`，整个回执释放事务回滚。本地复现中，该回执及排在其后的无关回执均保持 `unknown`。
- **影响：** 单个停用频道的回执使本轮全局恢复中断，后续回执、任务、归组及投递恢复均不能继续；下轮仍会遇到同一回执。
- **建议修复：** 将回执对账与重新入队分开处理；停用频道允许完成对账，但跳过重新入队，并保证单项失败不会阻断其他恢复项。
- **回归验收：** 停用频道的 unknown 回执可完成对账且不产生处理任务；同批其他频道回执及后续恢复步骤继续执行；重新启用后的恢复行为仍符合回执和处理代次约束。

## MS-002：配置更新隐藏历史译文

- **位置：** [publication/items.ts](../packages/backend/src/publication/items.ts) 的 `TRANSLATION_JOINS`（登记时第 72～78 行）；[editorial/translate.ts](../packages/backend/src/editorial/translate.ts) 的 `translatePending()`（第 371～374 行）。
- **触发与复现：** 新频道已有一篇十天前完成翻译的文章，仅修改 `siteName` 并激活新配置。公开读取按当前 `active_config_version` 过滤旧译文，而补译只处理最近三天发现或修订的文章。本地复现中，译文 `body_text` 读取为 `null`，`translatePending()` 返回 `{ done: [], quotes: 0 }`。
- **影响：** 与翻译无关的配置更新也会让历史译文消失；超出补译窗口的文章不会由现有定时任务恢复。
- **建议修复：** 区分影响翻译的配置与其他配置，保留仍适用的历史译文；若决定使旧译文失效，应提供覆盖受影响历史内容的恢复路径，避免读取失效范围大于补译范围。
- **回归验收：** 十天前的文章在仅变更站名后仍可读取有效译文；翻译相关配置变化时，按确定的失效策略验证历史内容恢复，且旧配置的在途结果不能覆盖新结果。

## MS-003：周报订阅窗口漏推

- **本地修复（2026-10-27）：** 用报告 `created_at` 判断首次发布，保留 `window_end` 用于内容窗口和发布时间边界。`deliveries.test.ts` 覆盖窗口先结束但新刊可投递、重试去重，以及重编旧刊不补推给新订阅者。
- **位置：** [notify/report-content.ts](../packages/backend/src/notify/report-content.ts) 将 `row.window_end` 作为 `contentAt`（登记时第 33 行）；[notify/deliver.ts](../packages/backend/src/notify/deliver.ts) 将其与目标的 `enabled_at` 比较（第 95 行）。
- **触发与复现：** 默认周报统计窗口在周日 08:00 结束、周一 10:00 出刊；周一早上启用报告订阅时，新刊的窗口结束时间已早于目标启用时间。本地复现使用“窗口昨天结束、报告现在生成、目标一小时前启用”，`pushReport()` 返回 `skipped / no new target`，没有生成 delivery。
- **影响：** 目标在出刊前已订阅，仍收不到新生成的周报；统计窗口结束时间被误用为通知的新旧内容边界。
- **建议修复：** 报告订阅按首次实际出刊时间判断是否为新内容，保留统计窗口用于报告内容；同时明确补刊和重编是否触发通知，维持去重约束。
- **回归验收：** 窗口结束后、首次出刊前启用的订阅能够收到该新刊；出刊后新增订阅不会自动补推旧刊；重编和重试不造成重复投递。

## MS-004：讨论帖重匹配使用错误配置版本

- **位置：** [events/group.ts](../packages/backend/src/events/group.ts) 的 `reclaimWaiting()` 和 `rematchSignals()`（登记时第 554、579 行）；任务版本校验见 [jobs/queue.ts](../packages/backend/src/jobs/queue.ts) 的 `work()`。
- **触发与复现：** 讨论帖在 v1 下采集并引用尚未收录的原帖；频道激活 v2 后，原帖到达并完成归组。重匹配将原帖的 v2 上下文传给仍固定在 v1 的讨论帖任务。本地复现返回 `reclaimed: 1`，生成任务却无法通过版本校验；直接执行报 `Grouping context changed before execution`，worker 会将其判为 stale。使用讨论帖自身的 v1 上下文立即得到 `signal-native`。
- **影响：** 日志显示已重匹配，讨论帖实际没有加入事件，也无法贡献对应热度。
- **建议修复：** 按每个被重匹配文章保存的配置版本生成任务，不复用触发报道的完整上下文；继续校验频道归属、输入修订和处理代次。
- **回归验收：** 跨配置版本的引用帖回收与相似讨论帖重匹配均可执行，并归入正确事件；过期代次及跨频道任务仍被拒绝。

## MS-005：后台更正未传播到非默认频道报告

- **本地修复（2026-10-27）：** 从文章归属解析配置，按该频道分类词表校验，并把同一上下文传给报告更正。`space-reports.test.ts` 通过真实 `overrideFields` 调用验证动态安全分类、报告修订、其他频道不变及错误分类不写入。
- **位置：** [reports/correct.ts](../packages/backend/src/reports/correct.ts) 的 `correctReportClassification()`（登记时第 15～21 行）；生产调用位于 [admin/content.ts](../packages/backend/src/admin/content.ts) 第 318 行。
- **触发与复现：** 后台更改非默认频道文章分类时，调用未传入频道上下文，helper 因而按 `default` 查询。本地通过 `overrideFields()` 将文章从 `ai-models` 改为 `paper` 后，publication 分类已变为 `paper`，日报仍留在“模型发布/更新”栏目、revision 仍为 1；显式传入正确上下文后，才移动到“论文研究”并生成 revision 2。
- **影响：** 文章与其已发布报告分类不一致，正常后台更正不能完成非默认频道报告的同步修订。
- **建议修复：** 由文章所属频道解析并传递更正上下文，使人工覆盖、publication、报告修订及审计继续处于同一事务。
- **回归验收：** 通过实际后台调用更正非默认频道分类或标签，所有相关报告按本频道规则同步更新并留存修订；其他频道报告不变；事务失败时不留下部分更正。

## MS-006：单连接池导致迁移永久等待

- **本地修复（2026-10-27）：** 默认频道初始化复用迁移已经保留的连接。`migrations.test.ts` 以 `DATABASE_POOL_MAX=1` 子进程验证重新初始化与重复迁移均结束，并读回活动配置。未修改历史迁移。
- **位置：** [scripts/migrate.ts](../scripts/migrate.ts) 的 `runMigrations()`（登记时第 91～94 行）；默认频道初始化见 [spaces/context.ts](../packages/backend/src/spaces/context.ts) 的 `ensureDefaultSpace()`。
- **触发与复现：** 设置 `DATABASE_POOL_MAX=1` 执行迁移。脚本仍持有 `sql.reserve()` 取得的唯一连接，却把连接池 `sql` 传给 `ensureDefaultSpace()`；初始化等待空闲连接，保留连接又要等初始化返回才释放。本地对无待迁移的数据库执行也未退出，三秒超时后以 SIGTERM 终止；同一数据库使用两连接时正常返回 `database is up to date`。
- **影响：** 允许的单连接池配置下，迁移和重复迁移都会卡住，不能完成应用启动前的数据库准备。
- **建议修复：** 默认频道初始化复用已经保留的连接，或在请求连接池前先释放该连接，并保持初始化与超时设置的预期边界。
- **回归验收：** 在 `DATABASE_POOL_MAX=1` 下，首次迁移及无待迁移的重复执行均能结束并正确读回默认频道配置；多连接池行为不退化。

## MS-007：跨频道后退、前进丢失历史快照

- **位置：** [apps/web/app/lib/session-cache.ts](../apps/web/app/lib/session-cache.ts) 的 `entryKey()`（登记时第 32 行）；离开页面时保存快照的调用见 [restore.ts](../apps/web/app/lib/restore.ts) 的 `useSaveOnLeave()`。
- **触发与复现：** `entryKey()` 在保存时读取实时 `browserSpace()`，但 `popstate` 触发离开页保存时，`window.location` 已指向目的频道。浏览器实测：默认首页 → security 频道 → 收起日期组 → 后退默认频道 → 前进 security，日期组重新展开；保存的 snapshot 键为 `aihot:list:<historyKey>`，缺少 `security` 作用域。
- **影响：** 离开页快照被记到目的频道范围，返回时无法按原频道命中；已加载列表、折叠状态及阅读位置的恢复依赖同一快照链路。
- **建议修复：** 快照读写显式使用该历史条目或页面绑定的频道，不在延迟保存和 `popstate` 回调中从目的地址重新推断作用域。
- **回归验收：** 在默认频道与非默认频道之间后退、前进，日期组折叠状态、已加载列表和阅读位置均恢复；快照始终写入原页面频道，频道之间不互相覆盖。
