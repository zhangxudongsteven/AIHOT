# 新机器接续准备与验证记录

日期：2026-10-23（Asia/Shanghai）。分支：`codex/prepare-development`。本轮整理前 HEAD 为 `ca8ccb3`，其前一提交 `b0ea3ed` 已归档 DEV-01～DEV-05。最终交接提交以该分支的 Git 历史为准。

## 整理内容

- 保留独立维护的开发基线，补齐 MacBook Pro 同机原生 PostgreSQL、应用 Compose、LAN 和后续 GCP 的部署文档与模板。
- 增加 [新机器开发与部署](../new-machine-setup.md)，指定当前开发分支，区分开发、测试和运行数据库，说明私有配置与业务数据的单独迁移方式。
- `.env.example` 的采集和模型开关改为默认关闭；新生成的环境默认关闭采集、模型、飞书和 IndexNow。已有私有环境文件不自动改写。
- 更新 README、更新日志及本地开发说明，区分已经验证的代码、一次真实模型联调、目标机器部署和业务验收。

## 本轮验证

运行环境为当前开发 Mac，Node.js 24.22.1、PostgreSQL 17。本轮不执行真实供应商调用、采集或消息推送。

| 检查 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build -w @aihot/web` | 通过 |
| 后端完整 `npm test` | **1033/1033 通过**，0 失败、取消或跳过；使用全新独立本机 `myhot_release_20261023_test`，约 43.18 秒 |
| `npm run test:standalone` | **231/231 通过**；这是额外的独立测试入口，不与完整套件相加计算唯一测试总数 |
| Web 测试 | **66/66 通过**，0 失败、取消或跳过；本机浏览器执行使用获准的权限及并发 2 |
| 迁移检查 | `--base HEAD` 通过；本轮没有新增或修改数据库迁移 |
| 部署脚本 | `bash -n scripts/deploy-lan.sh` 通过；部署行为的本地假服务测试通过 |
| Mac / LAN Compose 渲染 | 两套模板均通过；仅包含 setup、API、worker、Web，无 PostgreSQL 服务；外发固定关闭，Web 不接收后端凭证 |
| 新环境初始化 | 临时目录验证通过：全部外发开关为 false、生成私有密钥、拒绝覆盖已有 `.env`；临时凭证已删除 |
| Git 内容检查 | 检查待提交文件及已有待推送提交中的已知凭证和常见密钥格式；未发现实际凭证进入提交。`.env`、`.env.lan`、`.data/` 保持忽略 |
| 文档与格式 | 本地文档链接目标、Markdown 代码块及 `git diff --check` 检查通过 |

原始输出留在旧机器的 `.data/release-preparation/`，不随 Git 传输。主要日志为 `typecheck.log`、`web-build.log`、`web-tests-browser-permission.log`、`backend-fresh-tests.log`、`backend-standalone.log` 和 `backend-migrations.log`。

## 首轮失败与重新验证

保留失败证据，不通过修改测试超时或断言获得通过：

1. 默认沙箱中的 Web 浏览器测试遇到浏览器启动 `SIGABRT` / `EPERM`。停止本轮残留测试进程后，以所需本机权限原样重跑，66/66 通过；没有修改 Web 代码或测试断言。
2. LAN PostgreSQL 的同一次连接查询往返测得约 174～264 ms，首个查询约 1161 ms。回执、重试和备份阶段出现既定超时，因此停止该轮；退出统计为 373 项、229 通过、4 失败、140 取消，包含人工中止，**不是完整回归结果**。只清理本轮测试进程与克隆库，不操作业务库 `myhot`。
3. 原有本机 `aihot_test` 模板保留早期频道配置快照，缺少当前必需字段 `entityOrder`，该轮为 1033 项、528 通过、505 失败。保留旧模板及日志，没有改写旧配置来掩盖问题。
4. 改用新的独立测试模板，由当前迁移和配置初始化，完整套件 1033/1033 通过，覆盖上述回执、停机、重试和备份测试。这个结果证明当前代码在新初始化测试库上的回归通过，不证明旧配置数据升级问题已经解决。

项目专用 PostgreSQL 通过 `scripts/dev-database.sh` 临时运行于 `127.0.0.1:55432`，不接管系统数据库；测试结束后停止本轮启动的实例。新机器按交接说明创建自己的开发与测试数据库。

## 尚未完成的验证

- 当前开发机 Docker daemon 不可用，尚未执行本轮镜像构建、容器启动或目标 Mac 的部署。Compose 渲染和假服务测试不能替代容器实测。
- 本轮没有新启动应用进行 smoke/MCP；此前 Node 进程方式的验证见 [LAN 部署记录](2026-10-23-lan-deployment.md)，不能视为目标 Mac 的部署验收。
- 目标 Mac 的数据库监听、Docker 到宿主机连接、密码认证、持久化、主机重启恢复和备份恢复演练仍需执行。
- [MS-001～MS-007](../known-issues.md) 仍开放；正式安全信源、资产影响和处置闭环、完整模型流水线与飞书推送尚未验收。真实 DeepSeek 的局部验证见 [联调记录](2026-10-23-deepseek-integration.md)。
- GCP/GKE 仍为方案；本轮不代表远程 CI、云端或生产部署已经通过。

远程推送和全新克隆需在提交后核对实际提交哈希。新机器使用 [交接步骤](../new-machine-setup.md) 拉取 `codex/prepare-development`，不要把默认分支或旧机器私有状态当作交付内容。
