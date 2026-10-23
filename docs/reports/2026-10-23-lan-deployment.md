# LAN 部署文件与脚本验证

2026-10-23，基于 `ca8ccb3` 工作区准备。目标为 `172.16.0.17`，复用已有 PostgreSQL，采集、模型和推送保持关闭。状态：部署文件及脚本已准备，尚未执行服务器部署。

## 交付

- `compose.lan.yml`：独立项目 `myhot-lan`；仅 setup、API、worker、Web，不含数据库容器。setup 只迁移。Web 单独暴露局域网 3000 端口，后端使用环境变量白名单，外发开关固定关闭。
- `deploy/lan.env.example`：服务器私有配置模板。当前 checkout 已准备 Git 忽略的 `.env.lan`，数据库密码沿用已有环境变量，服务器管理员和签名密钥独立生成，权限 0600。
- `scripts/deploy-lan.sh`：配置检查、构建、只读连接预检、停止应用、数据库与文件备份、迁移、健康等待、smoke，以及 status/logs/stop。明确不管理 PostgreSQL、不 seed、不自动执行频道 cutover、不自动回滚数据库。
- [局域网部署与本机调试说明](../lan-deployment.md)。

## 验证

| 项目 | 结果与证据 |
| --- | --- |
| 类型检查 / Web 构建 | 通过，`.data/lan-deploy/typecheck.log`、`web-build.log` |
| 完整后端回归 | 1031/1031 通过，0 失败、取消和跳过，约 710 秒；`.data/lan-deploy/backend-tests.log` |
| 部署脚本最终回归 | 8/8 通过；包括全量回归启动后补充的 2 项环境路径测试，`.data/lan-deploy/script-tests.log` |
| Web 全量复跑 | 66/66 通过，使用 `--test-concurrency=2`，约 99 秒；`.data/lan-deploy/web-tests.log` |
| Compose 解析与安全配置 | 实际 Compose CLI 验证通过，无需 daemon；`.data/lan-deploy/compose-validation.json` |
| 实际只读数据库预检 | 用脚本中的预检代码连接既有 PostgreSQL，通过版本及 pg_dump 兼容检查；`.data/lan-deploy/preflight.log` |
| 迁移与差异检查 | 迁移历史、在线语句检查及 `git diff --check` 通过 |
| 实际 Node 运行时 | 独立临时库完成 187 项迁移，API/worker/Web、smoke、MCP 和 worker 心跳检查通过；`.data/lan-deploy/runtime-result.json` |
| 清理与开发库回读 | 测试克隆和临时运行库已清理；开发库仍为 187 项迁移、1 个频道、0 篇文章、0 条模型回执；`.data/lan-deploy/postflight.json` |

Web 首次默认并发执行为 65/66，端口 0 用例在 15 秒内未收到服务器启动信息。原样单例复跑通过（约 458 毫秒），随后限制同时执行的测试文件数，全量 66/66 通过。未修改断言、业务代码或超时，首次和单例日志分别保存在 `web-tests-first.log`、`web-tests-retry.log`；没有将资源竞争推测当作已证实的根因。

部署脚本测试使用临时目录和 fake Docker，验证构建或预检失败不停止旧服务、备份或迁移失败不启动新应用、成功执行顺序、备份权限、环境变量优先级，以及失败后不自动回滚。复核发现并修复自定义环境文件可能被 `COPY . .` 带入镜像的问题：仓库内仅允许 `.env.lan` 或 `.data/`，其他配置必须位于仓库外，拒绝符号链接；相应负例与允许路径均已回归。测试记录只保存继承变量是否存在，不记录其值。

实际运行验证使用新的 `myhot_lan_smoke_<timestamp>_test` 数据库、临时身份密钥和关闭的全部外发开关。模型回执、请求尝试和实际推送均为 0；进程正常退出，临时数据库删除。它验证 Node 应用运行，不代表 Docker 镜像或容器已通过验证。

## 待服务器执行

本机 Docker Compose CLI 可用，但 Docker daemon 未运行。`deploy-lan.sh check` 在 daemon 检查处明确失败并退出，记录在 `.data/lan-deploy/deploy-check.log`；本轮未构建镜像、未启动容器，也未执行 SSH 部署。后续在服务器完成 `check`、`deploy` 和局域网访问检查，才能记为部署成功。备份文件的可读性检查不替代实际恢复演练。[已知问题](../known-issues.md)仍保持原状态。
