# 局域网 PostgreSQL 开发与测试验证

验证日期：2026-10-23。代码基线：`ca8ccb3`（公开接口 4.1.0）。本轮验证数据库环境和现有功能，没有修改业务代码，也没有部署生产。

## 环境与权限

- 数据库端点：`172.16.0.17:5432`，服务端 PostgreSQL 17.11。
- 账号：`myhot`，已回读确认 `CREATEDB=true`、`SUPERUSER=false`，可以连接 `postgres`。
- 开发库：`myhot`；后端测试模板：`myhot_macbook_air_test`。测试框架从模板为每个测试文件创建独立数据库。
- 密码通过私有 `PGPASSWORD` 环境变量提供，`DATABASE_URL` 不含密码；`.env` 和 `.data/lan-postgres/{dev,test}.env` 被 Git 忽略，权限为 0600。
- Node.js 24.22.1；本机 PostgreSQL 17.11 客户端执行真实 `pg_dump` / `pg_restore` 测试。

## 本轮结果

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| 类型检查 | 通过 | `.data/lan-postgres/typecheck.log` |
| Web 构建 | 通过 | `.data/lan-postgres/web-build.log` |
| 完整后端回归 | 1025/1025 通过；失败、取消、跳过均为 0；约 650 秒 | `.data/lan-postgres/backend-tests.log` |
| 完整 Web 回归 | 66/66 通过；失败、取消、跳过均为 0；约 20 秒 | `.data/lan-postgres/web-tests.log` |
| 迁移历史与在线安全检查 | 通过 | `.data/lan-postgres/migration-check.log` |
| 独立临时库初始化 | 187 项迁移通过 | `.data/lan-postgres/runtime-migrate.log` |
| 实际 API、worker、Web 启动 | 通过；健康检查 `db=ok`，worker 心跳已回读 | `.data/lan-postgres/runtime-result.json` |
| 网站 smoke / MCP 合约 | 均通过 | `.data/lan-postgres/runtime-smoke.log`、`runtime-mcp.log` |
| 测试库清理与开发库回读 | 通过 | `.data/lan-postgres/preflight.json`、`postflight.json` |

完整后端测试沿用仓库默认 6 并发和 120 秒测试超时，没有降低断言或跳过测试。覆盖包括真实数据库备份恢复、频道配置与隔离、报告、通知记录、配额、翻译和公开接口。采集与模型测试仅连接本机假服务；飞书与 IndexNow 外发关闭。测试不读取应用 `.env`。

实际进程检查使用单独的 `myhot_lan_smoke_<timestamp>_test` 库，API、worker 和 Web 在本机临时端口运行。采集、模型、飞书和 IndexNow 开关均关闭，使用临时身份密钥。回读模型回执、请求尝试和已发送通知均为 0；所有子进程正常退出，临时数据库已删除。

测试结束后，数据库清单中仅保留本项目开发库 `myhot` 和可复用模板 `myhot_macbook_air_test`，没有本轮测试克隆或恢复库残留。两库均有 187 项迁移；测试模板的文章与模型回执为 0。开发库回读与测试前一致：1 个默认频道、0 篇文章、0 条模型回执。

运行命令和数据库切换方式见[本地开发说明](../local-development.md)。原 DEV-02 隔离实验仍限定 loopback，本轮没有修改该限制或将实验迁往局域网。此次通过不代表[已知问题](../known-issues.md)已修复，也不代表真实模型、正式信源、推送或 GKE 上线已验收。
