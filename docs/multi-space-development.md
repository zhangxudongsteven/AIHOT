# 频道配置与处理上下文

DEV-03～DEV-05 在同一套 API、worker、数据库和网站中实现频道内独立处理、阅读、报告、推送和配额。验证记录见 [DEV-05](reports/2026-10-23-dev05.md)、[DEV-04](reports/2026-10-23-dev04.md) 和 [DEV-03](reports/2026-10-23-dev03.md)。

当前开发版本的公开接口为 **4.1.0**。2026-10-23 评审确认的 7 项问题（1 项 P1、6 项 P2）均保留待修复，详见[已知问题](known-issues.md)及[评审与版本记录](reports/2026-10-23-review.md)。以下描述是已实现能力；配置切换、恢复、报告更正和浏览器历史等已知例外以问题记录为准。本次归档不包含这些问题的修复，也不表示生产部署或业务验收完成。

本项目后续独立维护，不再以向原项目贡献为目标。版本记录见 [CHANGELOG.md](../CHANGELOG.md)，项目版本、公开接口版本与站点日志的分工见[维护约定](fork-maintenance.md)。

## 当前边界

| 能力 | DEV-05 行为 |
| --- | --- |
| 配置 | `spaces` 登记频道，`space_configs` 保存不可变完整快照；内容 SHA-256 是版本号 |
| 快照内容 | 分类、词表、提示词、门槛、身份规则、模型路由和模型规格、报告排程与文案；凭证只保存环境变量名称 |
| 来源与文章 | 每频道独立来源、游标、文章、修订、处理状态和 publication；频道内判重，跨频道可有同一 URL |
| 任务 | 频道、配置版本、输入修订和处理代次随任务保存；旧结果不能覆盖新代次；未知、停用或归属不符时拒绝处理 |
| 事件 | 召回、事实关系、归组、摘要、热度、合并和关联限定频道；归组有独立代次 |
| 付费回执 | 频道调用及 attempt 记录频道/配置；保留平台总预算与 unknown 核对规则 |
| 公开入口 | 旧地址固定 `default`；新增网站、API、RSS、Markdown、MCP、OG、sitemap 等频道地址；对象、游标、服务器缓存和浏览器内容状态均限定频道 |
| 报告与翻译 | 各频道独立日报/周报/月报、修订、翻译与引用帖译文；网站展示报告入口，所有读取仍限定频道 |
| 推送与配额 | 各频道独立目标/订阅/投递记录和请求配额，可显式保留平台容量；管理 API/CLI 可配置并读回，管理站尚无完整频道切换界面 |

这不是租户权限系统。仍使用全局管理员身份。配置里的 `siteName` 作为频道名称展示，不修改共享品牌。登记、激活并启用的频道会出现在网站导航；此版本没有单独的“私有预览”开关，隔离验收应使用独立测试数据库。首次迁移保留原行业；没有将示例行业改名为网络安全，也没有导入新的正式信源。

## 配置生命周期

先按[本地开发说明](local-development.md)选择正确的数据库，确认外发关闭。命令需要 Node.js 24。以下 `security-preview` 仅是示例 ID，不代表已批准的正式配置。

```bash
# 创建新文件，不覆盖已有文件；导出不连接数据库。
node --env-file=.env scripts/space-config.ts export-default --out .data/security-preview.json
```

编辑 JSON 后先在测试库验证。不能只改站名：应一起检查分类、标签、词表及 `entityOrder`、所有相关提示词、身份规则和模型路由。门槛需要业务标注样本校准，正式来源、品牌和隐私条款需要负责人确认。`entityOrder` 显式保存提示词中的词表顺序，避免 PostgreSQL JSONB 重排对象键改变模型输入。

```bash
# 保存新版本；新频道初建时为 disabled。省略 --activate 只暂存版本。
node --env-file=.env scripts/space-config.ts apply \
  --space security-preview --slug security-preview \
  --file .data/security-preview.json --activate

# 完成下节切换并验证配置后才允许启用非默认频道。
node --env-file=.env scripts/space-config.ts enable --space security-preview
node --env-file=.env scripts/space-config.ts disable --space security-preview
```

`apply` 返回配置哈希、当前激活版本及启用状态；重复应用相同内容不会生成另一个版本。频道 ID/slug 稳定，命令不提供重命名。`disable` 阻止后续任务解析，不撤销已经发到供应商的请求，也不删除历史结果或回执。新版本激活不自动重评已有文章；重试和重归组沿用文章保存的版本，完整重评才切换到新版本和新代次。

显式频道任务读取冻结的配置。修改 `industry/`、`site/models.ts` 或模型环境变量后，应检查并应用新版本；离线 `export-default` 导出代码和环境默认值，不读取数据库里的后台覆盖。首次迁移会读取原站有效的后台模型选择，保留原有优先级；已有激活版本不会被后续迁移悄悄替换。

原后台的模型切换继续可用：预筛、评分、理解、写作、改用词、结构、归组/复核和事件摘要会在同一事务内为默认频道追加并激活新版本，同时记录审计。新评估用新版本，已排队任务保留原版本，其他频道不变。周/月报和翻译同样使用版本快照；模块能力保留原设置语义。后台显示默认频道当前快照的真实模型，其他频道由配置 CLI 管理。

模型 Key 和 Base URL 的值仍由运行环境提供；不要把实际凭证填入快照或提示词。可以在每频道模型规格中指定不同凭证引用；平台总预算与频道预算共同限制付费请求。

## 迁移与切换

DEV-05 新增迁移 `0190–0195`（报告与修订）、`0210–0222`（通知）、`0230–0231`（配额）、`0250–0257`（译文）；编号间留白无含义，以完整文件名账本为准。旧配置的可选 `reports` 字段不会被自动填入，已存哈希保持不变；导出新配置会包含此字段。原默认频道缺字段时保留站点文案和排程，旧非默认配置使用原排程与中性空刊文案，无行业专用发布指标。

1. 核对目标库，验证数据库与业务文件备份可恢复，记录旧数据量、任务和默认频道配置。停止并排空旧 API、worker、导入器及其他写入进程。
2. 使用新版本运行 `node --env-file=.env scripts/migrate.ts`。新增迁移按文件名记账；每文件一条语句，索引并发创建。默认频道登记与快照初始化由迁移脚本在 DDL 后执行。
3. 新 `space_id` 列以常量 `default` 归属历史数据，利用 PostgreSQL 的常量默认值机制，不做整表 UPDATE。旧分析的空配置版本只在默认频道、初始处理代次的兼容路径读取。回执按精确请求身份认领历史记录，unknown 不自动重发。
4. 常规迁移保留旧的全局 `articles.identity_key`、`reports(kind,key)` 和引用帖 `quote_translations.tweet_id` 约束。新频道复合唯一索引建立后，运行下面的显式切换。脚本先验证待验证的频道约束，再删除旧全局唯一约束；不删除行或重写文章/报告身份；引用帖改以 `(space_id,tweet_id)` 唯一。

```bash
node --env-file=.env scripts/space-cutover.ts --writers-stopped --backup-verified
```

两个参数是操作人的确认，脚本不能证明写入进程真的停止或备份可恢复。它检查新唯一索引和默认配置，以有限锁等待验证约束、删除实际存在的旧约束，支持重复执行。约束验证失败时先排查原数据或配置，不跳过检查。第一次运行可能逐表扫描，按实际数据量安排维护窗口。

5. 读回迁移账本、频道归属、活动配置及约束状态，启动一个新 worker 和 API/Web，运行 smoke/MCP。第二频道使用合成测试资料验证；正式启用还需真实业务输入、预算与投递目标配置及验收。

非默认频道的 CLI `enable` 会检查身份切换是否完成。不要直接改库绕过它。**切换后不能仅回滚镜像到未支持频道的旧版本**，尤其在第二频道写入后，旧查询会混读，新自然键也无法直接恢复为全局唯一。优先使用经过验证的频道兼容版本；必须恢复旧单站时，使用切换前数据库与业务文件备份并核对外部已付费/已投递记录。

当前开发库只验证普通迁移和默认频道；双频道写入、旧数据保留、约束验证和重复切换由独立测试库验证。尚未做真实公司数据库备份副本迁移或 GKE 恢复演练。

## 独立报告、推送和配额（DEV-05）

配置快照的 `reports` 包含 `editionTimes.{daily,weekly,monthly}`（北京时间 `HH:mm`）、`quiet.{title,paragraph}`、`plainTerms` 和 `release`。`release` 为 `null` 或 `{category,tag,unit}`；不适用模型发布等行业指标的频道应填 `null`。旧配置不会自动改变哈希；需要修改时导出、审阅并激活新版本。日报仍由规则编排，不调用模型；周/月报仅用本频道日报和本频道模型写总述。调度逐启用频道执行，一频道失败仍继续其他频道。排程按半小时轮询，在配置时间之后的首轮执行；它不是精确到分钟的定时器。

同一期按 `(space_id,kind,key)` 唯一，重编保留旧内容及配置版本。配置已切换或频道停用时，在途旧结果完成回执但不能覆盖当前报告、译文或排入通知。公开阅读不调用模型。日报缺刊按频道独立告警，原默认日期键保留，非默认键为 `report.daily:<space>:<date>`（space 按 URI 编码）。

新刊保存和 `notify.report` 入队在同一事务，精选使用 `notify.selected`；任务固定频道与配置版本。现有内容目标的 `subject_kinds` 默认只有 `selected`，报告必须显式订阅。新频道自动创建的目标是禁用且无凭证引用；不会继承默认群。投递仍要求全局 `FEISHU_CONTENT_ENABLED=true` 和目标启用同时成立。`unknown` 留待人工核验，不自动重发；手工重发重新读取本频道当前公开内容。禁用频道可做不发送消息的 `sent/drop` 对账。

以下是关闭真实发送的目标配置文件示例，`configRef` 是凭证名称，不能写 webhook URL 或密钥：

```json
{"name":"feishu-content-main","kind":"feishu_webhook","configRef":null,"subjectKinds":["selected","report"],"enabled":false,"reason":"准备频道投递配置，尚未启用"}
```

确认真实目标后，通过后端 integrations 凭证配置注入专用引用，再将 `configRef` 设置为该名称。配置新订阅或更换目标会重新记录启用时间，避免自动补推旧内容。CLI 的 `name` 在非默认频道自动变为 `space:<id>:<name>`，不要手动拼接前缀。

```bash
node --env-file=.env scripts/space-ops.ts target --space security-preview --file .data/target.json --actor operator
node --env-file=.env scripts/space-ops.ts budget --space security-preview --service llm --file .data/budget.json --actor operator
node --env-file=.env scripts/space-ops.ts show --space security-preview
```

`budget.json` 必填 `perMinute/perHour/perDay/reason`，可填 `reservedMinute/reservedHour/reservedDay`，均为非负整数；没有填入任何真实业务额度。任一上限为 0 停止该频道该服务，缺少频道预算行表示只受平台总预算限制。窗口是滚动 1 分钟、1 小时、24 小时；计量是**请求 attempt 数**，不是 token 或金额。实际失败、unknown、fallback 和重试仍计数；复用已收到的回执不新增 attempt。

保留额度必须显式配置，且不能超过本频道上限或平台对应窗口容量。其他频道和无频道平台调用不能消耗该保留额度中尚未使用的部分；不增加平台总容量。并发配置和 admission 共用服务锁，平台总限额不能下调到保留额度之下（全局设 0 的紧急停机除外）。内部告警/反馈仍是平台运维目的地，未改成业务频道群。

管理 API 使用已有管理员登录及 CSRF：`GET /api/admin/spaces/:spaceId/settings`、`PUT .../notify-targets`、`PUT .../budgets/:service`；投递核对为 `POST .../deliveries/:id/resolve`，提交 `outcome: sent/drop/resend` 与必填 `note`，记录管理员审计。配置写入及审计同事务；`show`/GET 可读回频道、目标、配额及已用量。管理站显示各目标的频道与订阅并可启停；完整频道管理表单后续再做。

## 开发验证

```bash
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/company_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/check-migrations.ts --base <变更前的Git引用>
# 站点启动后：
node scripts/smoke.ts --base http://127.0.0.1:3000
node scripts/mcp-check.ts http://127.0.0.1:3000/api/mcp
```

测试库名必须以 `_test` 或 `_ci` 结尾，账号需要建库权限。测试只使用本地 HTTP 假服务，飞书和 IndexNow 外发始终关闭。DEV-05 新增 `space-reports`、`space-notify`、`space-quotas`、`space-settings`，并扩展 `translate`、`daily-report-alerts`、`space-jobs`；此前关键测试位于 `space-editorial`、`space-jobs`、`materials`、`events`、`grouping-reliability`、`processing-recovery`、`report-candidates` 和来源相关套件；它们验证行为及数据库约束，不以新表存在代替隔离验收。

## 网站与公开出口（DEV-04）

| 入口 | 频道地址 |
| --- | --- |
| 网站 | `/channels/:slug`，文章 `/channels/:slug/items/:id`、事件 `/channels/:slug/story/:id`、专题 `/channels/:slug/topics/:topic` |
| 网站读取 API | `/api/site/spaces/:slug/...`；`/api/site/spaces` 返回启用频道的公开登记 |
| v1 / Agent Markdown | `/api/v1/spaces/:slug/...`；文章 Markdown 也可用 `/channels/:slug/items/:id/markdown` |
| RSS | `/channels/:slug/feed.xml`、`/channels/:slug/feed/...`，保留精选/分类及许可控制 |
| MCP | `/api/mcp/spaces/:slug`，所有工具使用该端点的频道，不接受参数切换到其他频道 |
| 发现与分享 | `/channels/:slug/sitemap.xml`、`llms.txt`、`openapi-v1.json`、`og/...` |

旧地址保留默认频道行为，不受 Cookie、上次选择或查询参数影响。未知/停用频道及异频道对象返回 404；跨频道同步游标返回 409，普通列表游标返回 400。默认频道的显式地址和旧地址读取同一内容，但各自生成对应范围链接和 ETag。

读取上下文由 API 解析登记和活动配置后，通过 `AsyncLocalStorage` 作用于同一次请求；没有切换进程全局行业配置。公开登记只返回 ID、slug、名称、配置版本；模型凭证和提示词不出现在 metadata。前端通过 HTTP 读取 API，SSR 从当前请求解析频道；导航、SEO 和分享 URL 跟随频道。收藏、已读、搜索历史、反馈草稿及页面缓存按频道分开；旧本地数据仍属于默认频道，外观和字体共享。

`selected_ledger` / `selected_state` 新增频道归属。seq 继续全局按提交顺序递增，watermark、epoch、snapshot/changes 按频道隔离；旧无频道游标仅默认频道接受。新增迁移 `0184`～`0189` 不删除历史数据，也不批量重建 ledger。

升级自 DEV-03 时，若测试/预运行环境已有非默认频道精选投影，应在开放其同步出口前，关闭外发并用 `publication/publish.ts` 的 `republishSource(sourceId)` 逐来源重建这些投影。它读取已存分析、不调用模型；请只选该频道来源、记录进度并核对 snapshot。默认频道原 ledger 由列默认值保留；没有非默认数据的新安装无需回填。停用频道后 API 拒绝新请求，已经分发到客户端或 CDN 的内容仍遵守原缓存有效期，不承诺远程副本立即消失。
