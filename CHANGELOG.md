# 本项目更新日志

本文件只记录 [zhangxudongsteven/AIHOT](https://github.com/zhangxudongsteven/AIHOT) 的独立开发，不代表上游发行记录。分叉前的历史以 Git 和[上游基线](https://github.com/KKKKhazix/AIHOT/tree/b3998dc6fc138eb9659f33f55eb38c1c716f0d57)为准。

开发者变更记录在这里，面向本站读者的更新单独维护在 [`site/changelog.json`](site/changelog.json)。项目版本与公开接口版本的关系见[维护约定](docs/fork-maintenance.md)。日期采用 Asia/Shanghai。

## 未发布

### 维护

- 确认独立维护方向：后续需求、修复与代码评审在本项目进行，不再以向原项目贡献为目标。
- 建立本项目 changelog，更新 README、贡献和反馈入口；站点日志移除继承的“网站上线”示例，避免把模板历史当作本站发布记录。
- 保留 `upstream` 来源参考及原许可证、版权和第三方声明；不更改 Git remote 或 GitHub 上的 fork 关系。
- MS-001～MS-007 仍全部待修复；本轮仅调整文档和日志，项目基线及公开接口版本继续为 4.1.0。

## 4.1.0 — 2026-10-23（开发基线）

本项目首个自维护开发基线，提交 `b0ea3ed`；并非上游 4.1.0 发行版，也不代表已部署生产。

### 新增

- 版本化频道配置及频道内独立来源、文章、任务、归组与处理结果。
- 统一网站频道切换，以及按频道隔离的 RSS、公开 API、Agent Markdown、MCP、分享图和发现入口。
- 独立日报、周报、月报、通知订阅与投递记录、请求配额和保留额度。
- 本地 PostgreSQL 开发工具、分阶段迁移及显式切换脚本、频道隔离与行为回归测试。

### 升级

- 公开接口版本从继承的 4.0.0 更新到 4.1.0；旧地址继续固定默认频道。
- 数据库升级需要按[部署说明](docs/deploy.md)及[频道说明](docs/multi-space-development.md)完成迁移和显式约束切换。

### 已知问题与验证

- [MS-001～MS-007](docs/known-issues.md)：1 项 P1、6 项 P2，均留待后续版本修复。
- 本地后端 1025/1025、Web 66/66，通过类型检查、构建、迁移检查及 smoke/MCP；版本更新后的公开出口回归 9/9 通过。详细范围和限制见[评审记录](docs/reports/2026-10-23-review.md)。
- 未完成生产部署或业务验收，未启用真实模型、外部采集及消息发送。
