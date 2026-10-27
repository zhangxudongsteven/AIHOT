# AI 与网络安全双频道配置

日期：2026-10-27（Asia/Shanghai）。本轮是本地开发和隔离验证，未部署线上、未启用真实采集、模型或消息发送。

保留现有 `default` 为 AI，旧网址继续读取它；新增 `security` 为面向技术负责人的网络安全频道。两者使用独立配置快照、信源、处理结果和日报。正式使用前需要确认来源、分类、标注样本及产出质量；候选包不会自动注册或启用频道。

## 候选配置

```bash
# Node.js 24；不加载 .env，不连接数据库，不调用模型。不覆盖已有目录。
node scripts/prepare-channel-configs.ts --out .data/channel-configs/review-01
node scripts/prepare-channel-configs.ts --validate .data/channel-configs/review-01
```

输出 `ai.config.json`、`security.config.json`、`ai.sources.json`、`security.sources.json` 和 `manifest.json`。文件权限为 0600，目录为 0700，全部在被 Git 忽略的 `.data/`。`--validate` 检查配置 schema、哈希、候选状态和来源数量，不代替后面的完整信源校验。

AI 配置来自仓库默认值和当前进程的模型配置环境变量，**不是线上活动配置或后台信源的导出**。已有站点应保留其活动 AI 配置；不要用此示例覆盖后台模型选择、门槛或正式来源。只保存模型规格和凭证环境变量名称，不读取私有凭证文件或保存实际 Key。

| 项目 | AI | 网络安全 |
| --- | --- | --- |
| 配置来源 | 原 `industry/` 与 `site/` 默认值 | `industry/channels/security/config.ts` 与 `prompts/` |
| 分类 | 保留模型、产品、行业、论文、教程、观点 | 漏洞与补丁、攻击与事件、威胁研究、防护实践、工具产品、政策行业 |
| 主题 | 保留现有词表 | 云与 Kubernetes、身份与访问、应用与 API、软件供应链、终端与勒索、网络边界、数据保护、AI 安全 |
| 日报 | 保留原排程 | 北京时间 08:00，`reports.release=null` |
| 候选来源 | 原示范清单 18 个 | 6 个 RSS，见下文 |
| 启用状态 | 所有导出的来源均为 `enabled:false` | 同左；导出不会创建频道 |

安全提示词单独覆盖相关性、评分、理解、结构、术语、摘要、归组、综述及翻译。保留七类内容类型的组织方式、五轴加权、原权重与数字门槛；安全门槛**未校准**，没有用户标注集，不提供准确率或召回率结论。

摘要优先保留影响产品/版本、利用前提与证据、修复版本和原文明示的缓解措施。公开 PoC 不等于在野利用；公开公告不证明公司受影响；原文没有措施时不生成措施、负责人或完成状态。`Token`、`Agent` 等按安全上下文翻译。

安全候选为 Google Cloud Security Bulletins、Microsoft MSRC、oss-security 的 SecLists 镜像、GitHub Security、Cloudflare Security 和 Kubernetes Blog。端点曾通过访问和 XML 解析，但未完成项目采集器和业务验收。MSRC 应按实际产品复核；Kubernetes Blog 是混合主题源，GitHub Security 不是全量 GHSA；oss-security 镜像不冒充官方厂商来源。全部默认只公开摘要和原文链接。

## 在隔离数据库准备频道与来源

先按[本地开发说明](local-development.md)建立独立测试数据库与私有连接文件，例如 `.data/channel-test.env`。不要使用线上 `.env`；保持采集、模型、飞书和 IndexNow 开关关闭。下面命令显式读取该测试文件，运行前清除终端继承的其他数据库连接变量。

```bash
# 仅针对新建的隔离测试库；原有 AI 频道不需要重导默认配置。
node --env-file=.data/channel-test.env scripts/space-config.ts apply \
  --space default --slug default --file .data/channel-configs/review-01/ai.config.json --activate
node --env-file=.data/channel-test.env scripts/space-config.ts apply \
  --space security --slug security --file .data/channel-configs/review-01/security.config.json --activate

# plan 只读数据库：整份 schema、频道机构归属、全局 ID 和同频道采集地址重复检查。
node --env-file=.data/channel-test.env scripts/space-sources.ts plan \
  --space security --file .data/channel-configs/review-01/security.sources.json

# apply 只新增，不覆盖已存在的人工设置；不抓取内容。
node --env-file=.data/channel-test.env scripts/space-sources.ts apply \
  --space security --file .data/channel-configs/review-01/security.sources.json --actor local-operator
node --env-file=.data/channel-test.env scripts/space-sources.ts list --space security
```

AI 来源也可用同样的 `plan/apply/list --space default` 准备。`apply` 会先校验整份文件，再逐条创建；不是批量事务。执行中失败可能已有部分条目创建，读回后重跑，已存在的 ID 保留。不同频道可以采集同一 URL，但来源 ID 全局唯一；`sec-` 前缀用于候选安全来源。操作留存管理员审计。

新频道仍为 disabled，可先完成来源准备。停用频道可以列表、读取、创建和编辑；有既有文章时，要求重发布的修改会返回冲突，避免重新启用后出现陈旧公开投影。预览及手工采集要求频道启用，且会发起抓取；它们与只读 `plan` 不同。真实采集和启用需后续验收，本轮不执行。

管理 API 沿用管理员身份和 CSRF，默认地址固定 `default`，显式频道接口为：

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/api/admin/spaces/:spaceId/sources` |
| POST | `/api/admin/spaces/:spaceId/sources/preview` |
| GET / PATCH | `/api/admin/spaces/:spaceId/sources/:id` |
| POST | `/api/admin/spaces/:spaceId/sources/:id/preview`、`.../:id/fetch` |

异频道来源返回 404，不因全局 ID 能猜到就跨频道读取。完整后台频道表单仍未实现，当前通过 API 和 CLI 管理。

## 分频道评测

`eval-selection.ts` 支持 `--space` 和可选的 `--config-version`。启动时固定完整快照；模型规格、预筛、两次评分、档位门槛和回执均使用该快照。输出记录 `spaceId/configVersion/promptVersion`，文件名包含频道。未知、停用、配置损坏或模型不存在会在调用前失败。

非默认频道必须提供独立 `--gold` 和 `--no-import`。当前 SelectBench 仍仅管理默认 AI；后台上传也拒绝带有非默认频道身份的报告。历史无频道元数据的 AI 报告继续可用。

评测前须在隔离库按[频道迁移约定](multi-space-development.md#迁移与切换)完成身份切换，再显式 `space-config.ts enable --space security`；上面的来源准备步骤仍使新频道停用，直接评测会被拒绝。以下是后续完成样本和调用预算确认后的评测入口，本轮仅用本地假模型测试该能力，没有执行真实评测：

```bash
node --env-file=.data/channel-eval.env scripts/eval-selection.ts \
  --space security --gold .data/security-gold.jsonl --split all --no-import
# --config-version <哈希> 可以复测已保存的历史规则版本。
```

标注字段、开发/留出集及阈值扫描见[精选校准说明](selection.md)。不要把合成测试材料、候选门槛或脚本运行成功当成人工标注与业务校准。

## 日报、推送与后续边界

日报复用已生成的标题摘要并按规则编排，周/月报再用模型写总述；仅改 `report-period` 提示词不会新增日报行动清单。现有上限仍为 12 条正文、10 条快讯、同来源正文最多 2 条。

报告通知按首次保存时间判断订阅新旧；统计窗口结束时间和后续重编时间都不作为新刊时间。订阅后首次发布的迟到刊物可以投递，已发布旧刊不会因重编补发给新订阅者；同报告仍按原投递身份去重。

本轮修复 MS-001、MS-003、MS-005、MS-006，详见[问题状态](known-issues.md)。MS-002 历史译文、MS-004 讨论重匹配及 MS-007 浏览器历史快照仍待修。配置仍可能触发历史译文问题，应在修复前避免频繁切换正式配置。

非默认频道主题目录由词表派生，暂不支持自定义一级分组。普通资讯评分与日报不承担紧急安全告警；资产版本核验、确定性风险级别和内部处置状态需要后续安全模块。内部资产与负责人信息不进入公开内容和普通模型请求。

本轮验证与未验收范围见[开发验证记录](reports/2026-10-27-ai-security-channels.md)。
