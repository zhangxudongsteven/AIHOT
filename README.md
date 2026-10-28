# 多频道开发分支

这是基于 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) 独立维护的开发分支，当前仓库为 [zhangxudongsteven/AIHOT](https://github.com/zhangxudongsteven/AIHOT)。后续需求、修复、版本和更新日志由本项目维护，不再以向原项目贡献为目标。

项目提供统一网站，在不同业务频道中独立采集资料、筛选写作、归组事件、生成日报/周报/月报，并通过网站、RSS、公开 API、Agent Markdown 和 MCP 提供内容。当前推进 AI 与网络安全，出海政策与 3C 硬件后续接入；正式站名、品牌及完整信源与业务规则仍待确定，页面上的 `MyHOT` 是占位配置。

[English](README.en.md) · [更新日志](CHANGELOG.md) · [维护约定](docs/fork-maintenance.md) · [已知问题](docs/known-issues.md)

## 当前状态

当前项目版本为 **4.2.0**，公开协议版本保持 **4.1.0**；版本标签 `v4.2.0` 对应源码归档，不代表线上已升级。

首个自维护开发基线为 **4.1.0**（提交 `b0ea3ed`），分叉时的上游基线为 `b3998dc6fc138eb9659f33f55eb38c1c716f0d57`，后续修复按项引入。这些版本记录只代表本项目，不代表上游发行版。

- DEV-01～DEV-05 已接入频道配置快照、采集与处理上下文、网站切换及公开出口、独立报告、通知订阅和请求配额。
- 截至 2026-10-28，`main` 已合并后台频道管理、来源日期精度与安全公告采集，以及[六个上游日期和登录页修复](docs/reports/2026-10-28-upstream-six-fixes.md)。六修复基线在 Node 24 下完成后端 1095/1095、Web 99/99、类型检查、构建及 smoke/MCP；结果对应报告中的固定版本，不代表后续改动自动通过。此前 4.2.0 验证见[开发记录](docs/reports/2026-10-27-ai-security-channels.md)。
- 评审登记的 [7 项问题](docs/known-issues.md)中，MS-001、MS-003、MS-005、MS-006 已修复并归入 4.2.0（实现提交 `e341acb`）；其余三项待修。
- [双频道候选配置](docs/ai-security-channels.md)导出仍默认禁用；10 月 28 日已按使用者授权在 `myhot-lan` 分批启用部分 AI 新闻、arXiv 论文摘要与 Node.js / Spring 安全来源，见[运营记录汇总](docs/reports/2026-10-28-operations-summary.md)。这些是指定运行环境中的操作，拉取源码不会复现来源启用或数据库状态；安全门槛仍未校准。
- 真实采集、正文与日期读取、模型预筛和双评分已有小样本验证；论文试运行仍须观察分页、跨版本重复、异步处理和产出质量。AI 内容推送订阅在这些操作中保持关闭，不能据此推断其他频道的发送状态；开发环境继续关闭真实采集、模型和外发，staging 保持隔离且强制关闭外发。
- 已有 [LAN 运行环境](docs/lan-deployment.md)与[隔离 staging](docs/reports/2026-10-28-source-dates-staging.md)验收记录。MacBook Pro 原生 PostgreSQL 的[部署模板](docs/macbook-deployment.md)是另一种部署方式，其目标机器验收仍需单独完成。正式安全证据、资产影响与处置流程、持续运营验收及 GKE 部署仍待推进。

## 本地开发

使用 Node.js 24、PostgreSQL 17 和 npm workspaces。完整初始化、私有连接文件及进程启动方式见[本地开发说明](docs/local-development.md)。开发时保持真实采集、模型调用、飞书和 IndexNow 外发关闭。

```bash
git clone --branch main https://github.com/zhangxudongsteven/AIHOT.git
cd AIHOT
npm ci
```

以本仓库的 `main` 为开发与部署基线，后续开发从 `main` 新建分支并通过 PR 合并。完整的新机步骤见[新机器开发与部署](docs/new-machine-setup.md)。Git 只携带代码、模板和文档；数据库、文件卷和实际凭证需单独准备。远程分支与提交以 `git ls-remote` / `git fetch` 核验。

站点定制见[配置说明](docs/customize.md)，多频道配置、显式数据库切换和升级边界见[频道说明](docs/multi-space-development.md)。Docker 和其他部署方式见[部署文档](docs/deploy.md)。默认示范信源与行业配置不是已经批准的正式业务配置。

常规代码检查：

```bash
npm run typecheck
npm run build -w @aihot/web
# DATABASE_URL 必须指向独立的 *_test 或 *_ci 数据库；只连接本地假服务。
DATABASE_URL=postgres://127.0.0.1:5432/company_test npm test
node --test apps/web/tests/*.test.ts
# 本地站点启动后：
node scripts/smoke.ts --base http://127.0.0.1:3000
```

## 目录与文档

| 入口 | 用途 |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | 本项目开发版本、未发布改动与升级摘要 |
| [site/changelog.json](site/changelog.json) | 本站读者看到的更新日志，独立于上游历史 |
| [开发计划](docs/development-plan.md) | 业务范围、开发阶段与尚缺输入 |
| [新机器开发与部署](docs/new-machine-setup.md) | 获取 main 基线、隔离开发/运行数据、恢复私有配置与验收 |
| [已知问题](docs/known-issues.md) | MS-001～MS-007 的复现、影响和修复验收 |
| [10 月 28 日运营汇总](docs/reports/2026-10-28-operations-summary.md) | AI、安全与论文来源操作、公开验证摘要及未验收事项 |
| [频道说明](docs/multi-space-development.md) | 配置、任务、公开出口、报告、推送及配额 |
| [架构](docs/architecture.md) | Web/API/worker、模块、数据库迁移与公开读取层 |
| [信源](docs/sources.md) | 采集类型、正文许可、日期与外部推送 |
| [精选与校准](docs/selection.md) | 评分结构、样本校准及入选门槛 |
| [事件归组](docs/grouping.md) | 事件关系与归组评测 |
| [综述评测](docs/story-digest-evaluation.md) | 事件综述的样本比较与验证 |
| [site/](site/) / [industry/](industry/) | 站点配置、品牌模板与示范行业知识 |
| [modules/](modules/) | 独立业务模块 |

## 维护与问题反馈

工作在[当前仓库](https://github.com/zhangxudongsteven/AIHOT)内评审和提交，见 [CONTRIBUTING.md](CONTRIBUTING.md)。已知缺陷先查[问题清单](docs/known-issues.md)，安全问题按 [SECURITY.md](SECURITY.md) 联系本项目维护者。

`upstream` 仅保留来源与可选补丁参考。是否引入某个上游修复由本项目逐项评审和验证，不默认同步上游版本。维护约定及版本边界见[独立维护说明](docs/fork-maintenance.md)。

## 来源与许可

感谢原作者数字生命卡兹克及上游贡献者。保留 [MIT LICENSE](LICENSE) 中的原版权声明与 [NOTICE](NOTICE) 中的第三方素材说明。上游名字和 Logo 不作为本项目品牌，正式站名和品牌由使用者确定。分叉前的源码与文档历史保留在 Git 中。
