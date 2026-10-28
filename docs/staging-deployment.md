# 本机隔离 staging

使用独立开发分支和 checkout，复用 PostgreSQL 17 服务，应用仍由 Compose 管理。
当前机器的 PostgreSQL 实际由 `postgres-lan-postgres-1` 提供，地址为
`172.16.0.17:5432`，并非此前模板描述的原生 PostgreSQL。

| 资源 | 当前运行环境 | staging |
| --- | --- | --- |
| Compose 项目 | myhot-lan | myhot-staging |
| Web | 127.0.0.1:3100 | 127.0.0.1:3200 |
| 数据库 | myhot | myhot_staging |
| 数据库账号 | myhot | myhot_staging |
| 文件卷 | myhot-lan_data | myhot-staging_data |
| 网络 | myhot-lan_default | myhot-staging_default |
| 镜像仓库 | myhot-lan-app | myhot-staging-app |

`compose.staging.yml` 叠加已提交的 `compose.lan.yml`，不复制生产目录中的未提交改动。
Docker Compose 需支持 `!override` 和 `up --wait`，宿主机需要 Python 3。
API、worker、Web 各限制 1 CPU 和 512 MiB 内存。数据库服务及镜像构建仍共享宿主机资源，
因此这种隔离不能隔离数据库服务故障，也不适合对运行环境无影响的压力测试。

## 数据库准备

由管理员创建 `myhot_staging` 登录账号和同名数据库。账号使用独立随机密码，
拥有自己的库，禁止 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION、BYPASSRLS，
连接数上限 16；数据库撤销 PUBLIC 权限，由管理员预装 `pg_trgm`。
密码通过受限文件或交互输入传递，不放入命令行、Git 或镜像。

数据库认证文件在既有规则之前加入以下仅针对新身份的规则，先备份文件，
检查 `pg_hba_file_rules` 没有错误再执行 `pg_reload_conf()`，无需重启数据库：

```text
local myhot_staging myhot_staging scram-sha-256
host myhot_staging myhot_staging all scram-sha-256
local all myhot_staging reject
host all myhot_staging all reject
local myhot_staging all reject
host myhot_staging all all reject
```

这些规则让 staging 账号只能访问 staging 库，其他普通账号无法连接新库；
数据库管理员需要维护此库时使用受控管理方式。共享实例的超级用户仍属于信任边界。
必须实测正确密码成功、错误密码失败、staging 账号连接运行库失败。

## 配置与操作

将 `deploy/staging.env.example` 复制到 `.data/staging/deploy.env`，目录权限 0700、
文件权限 0600。填入 staging 独立数据库密码、管理员密码、会话和图片签名密钥。
`AIHOT_RELEASE` 使用可追溯提交标识；不要覆盖已验收版本的镜像标签。
Web 入口固定为 `http://localhost:3200`。

```bash
python3 scripts/deploy-staging.py check
python3 scripts/deploy-staging.py build
python3 scripts/deploy-staging.py deploy
python3 scripts/deploy-staging.py verify
python3 scripts/deploy-staging.py status
python3 scripts/deploy-staging.py logs
python3 scripts/deploy-staging.py stop
python3 -m unittest discover -s scripts/tests -v
```

脚本清除终端中的应用与 Compose 插值变量，读取唯一的私有 staging 环境文件，
在动作前校验渲染配置的数据库身份、项目、镜像、端口、网络、卷和外发开关。
部署先以候选镜像检查数据库身份及权限，再只停止 staging 应用、迁移 staging 库、
启动 staging 三个服务并运行整站 smoke。`build` 与 `deploy` 分离，部署不重新构建镜像。
不要用 `deploy-lan.sh` 操作 staging，它固定选择当前运行项目。

采集、模型、飞书内容推送、飞书内部通知及 IndexNow 固定关闭；没有模型或飞书凭据。
首次部署不导入信源、不启用安全频道，空页面属于正常结果。
后台密码仅保存在上述私有环境文件；不要将完整 Compose config 打印到日志。

## 数据和后续发版

当前 staging 从空库初始化。本轮没有复制运行数据或变更运行环境。
后续若需要真实数据升级演练，先单独备份 staging 数据库与文件卷，再停止 staging，
从运行环境的一致性备份恢复到 staging 专用库和卷，并调整对象归属。
启动前清除管理员会话、通知目标及集成凭据、关闭来源和外发，核对频道快照中凭据引用。
不能将未经清理的运行库备份直接启动为 staging。

重复部署不自动备份或回滚 staging；重要演练数据须先备份。迁移失败保持 staging 停止，
检查日志后决定重试或恢复 staging 备份。不得用旧镜像直接猜测新 schema 的兼容性。
通过后记录源码提交、镜像 ID、迁移差异与验收结果，再单独执行当前运行环境的发布流程。
当前脚本只管理 staging，不包含自动生产提升、数据复制或数据库账号创建。

## 2026-10-27 首次验收

基于 main `ff760653`（4.2.0），开发分支 `codex/isolated-staging`。
新建库迁移成功，三个容器 healthy，整站 smoke 全部通过。
staging 文章、来源和付费回执均为 0；外发开关全部 false。
正确密码成功、错误密码被拒绝，连接 `myhot` 和 `postgres` 被 HBA 拒绝。
读回卷与网络均为 staging 专用名称。运行环境 API 容器 ID、镜像 ID 和启动时间未变，
原站 `/api/health` 返回 `99f7c40-local`，staging 返回 `4.2.0-staging-dev`。
本轮不宣称真实数据恢复演练或安全频道业务验收完成。

提交后的运行版本为 `6bf1c03-staging`（实现提交 `6bf1c03`），健康接口可读回此版本。
后台独立密码登录、来源管理页面和退出撤销会话验证通过；MCP 完整契约检查通过。
隔离配置检查 3/3、既有 LAN 部署检查 8/8、类型检查、Web 构建及 Web 测试 66/66 通过。
刻意注入运行库地址、3100 端口、项目名和模型开关等终端变量后，staging 入口仍读取
自己的环境文件并通过配置检查。私有配置位于独立 checkout 的 `.data/staging/deploy.env`，
不会提交或进入镜像。原始构建、部署与测试输出保存在同目录受限日志中。

完整后端最终回归为 **1046/1046**，在临时 Node 24.22.1 测试容器和
`myhot_staging_suite_test` 独立模板库执行，测试只连接本地假模型和采集服务。
首次宿主测试错误地继承关闭采集/模型的开关，随后测试镜像暴露了生产模式、缺少开发依赖
和 Git 元数据、评测目录不可写的问题；修正测试环境后完整重跑通过，未更改业务断言。
临时测试容器退出删除，测试用管理员凭据文件已删除。运行库和 staging 业务库未作为测试库。
