# 新机器接续开发与部署

整理日期：2026-10-23。本文面向新的 MacBook Pro：先从远程取得代码并恢复开发环境，再部署应用；PostgreSQL 17 原生运行在 Mac 上，不纳入 Compose。GCP 是后续迁移目标，见 [GCP 部署方案](gcp-deployment-plan.md)。

本文记录获取与验证步骤，不代表目标机器已部署，也不单独证明提交已推送。远程分支及提交以 `git fetch` / `git ls-remote` 的实际结果为准。

## 1. 获取 main 基线

在新的开发目录执行：

```bash
git clone --branch main https://github.com/zhangxudongsteven/AIHOT.git
cd AIHOT
git status --short --branch
git log -1 --format='%h %s'
```

后续更新本仓库的 `main` 时，先处理本机未提交的修改，再执行 `git pull --ff-only`。开发新功能时从 `main` 新建 `codex/` 前缀的分支，并通过 PR 合并。本项目已独立维护，使用当前仓库的 `main`，维护规则见 [维护约定](fork-maintenance.md)。

先读 [README](../README.md)、[开发计划](development-plan.md)、[已知问题](known-issues.md) 和 [本轮交接验证](reports/2026-10-23-new-machine-handoff.md)。提交和测试结果需要与实际 checkout 对应，旧机器曾通过的测试不能代替新机器的检查。

## 2. 安装工具，划分数据

开发使用 Node.js **24.22.1 或兼容的更新 24.x 版本**，最低版本为 `24.22.1`；`.nvmrc` 固定为 `24.22.1`。已有 nvm 时：

```bash
source "$HOME/.nvm/nvm.sh"
nvm install
nvm use
node --version
npm ci
```

依赖由 lockfile 重装，不复制旧机器的 `node_modules`、Web 构建产物或缓存。PostgreSQL 服务端、`pg_dump` 和 `pg_restore` 均使用 17。应用容器部署还需要可用的 Docker Desktop；仅本地开发不需要 Docker daemon。

同一台 Mac 可以同时承担开发与运行，但数据和进程要分开：

| 用途 | 建议配置 | 管理方式 |
| --- | --- | --- |
| 应用运行库 | 原生 PostgreSQL，`5432`，独立库与账号 `myhot` | 按 [Mac 部署说明](macbook-deployment.md) 管理；Compose 只连接它 |
| 本地开发库 | 项目自带脚本创建的 `127.0.0.1:55432/aihot_dev` | `scripts/dev-database.sh` 管理独立开发实例；不接管运行库 |
| 自动化测试库 | 上述开发实例中的 `aihot_test` | 测试框架按文件创建和清理克隆库；不存业务数据 |
| DEV-02 原型库 | 上述开发实例中的 `aihot_space_test` | 仅用于原型验证 |

测试账号需要 `CREATEDB` 和连接 `postgres` 数据库的权限；应用运行账号不因测试需要而获得该权限。若多人共享数据库服务器，每人另选独立、以 `_test` 或 `_ci` 结尾的模板名，不能并发使用同一测试模板。

本地开发实例的初始化：

```bash
# 未安装 PostgreSQL 17 时执行；已有安装则直接设置下面的路径。
brew install postgresql@17
export PG_BIN="$(brew --prefix postgresql@17)/bin"
export PATH="$PG_BIN:$PATH"
bash scripts/dev-database.sh start
```

该脚本只管理当前 checkout 的 `.data/dev-postgres`，监听 `55432`，不会启动或修改运行库的 Homebrew 服务。其数据库原始目录不应直接从另一台机器复制过来；已有数据库迁移使用逻辑备份与恢复。

## 3. 恢复私有配置，再启动开发

Git 不携带 `.env`、`.env.lan`、`.data/`、数据库内容、Docker 数据卷或实际凭证。新机器需要重新配置，或通过可信的加密通道单独传输必要文件；不要把它们加入提交或贴到日志中。

| 内容 | 新机器的处理方式 |
| --- | --- |
| 开发 `.env` | 新建独立身份配置；如需接续原环境，先判断哪些签名密钥必须保留 |
| 数据库密码、DeepSeek Key、飞书凭证 | 重新配置或单独安全转移；文件权限设为 `0600` |
| `.data/dev-postgres/*.env` | 在新 checkout 运行开发数据库脚本生成，不沿用旧绝对路径和账号密码 |
| 运行数据库、频道快照、配额、回执 | 从经过验证的数据库逻辑备份恢复；不随源码克隆 |
| 上传文件、反馈截图等共享文件 | 另行归档、传输并恢复到应用 `/data`；不混入数据库原始目录 |
| `.data` 中调试进程记录、日志和一次性脚本 | 仅作旧机证据；不作为新机器的启动配置或可重复执行脚本 |

如果新 checkout 没有 `.env`，运行一次：

```bash
node scripts/init-env.ts
chmod 600 .env
```

脚本拒绝覆盖已有 `.env`，并在终端输出一次新管理员密码，应私下保存。启动应用前，检查 `.env` 中以下值全部为 `false`，不要把 `.env` 当作 shell 脚本 `source`，其中的 JSON 配置未必符合 shell 语法：

```dotenv
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
FEISHU_CONTENT_PUSH_ENABLED=false
FEISHU_INTERNAL_ENABLED=false
INDEXNOW_SUBMIT_ENABLED=false
```

API、worker 和迁移终端使用本机开发连接文件；它由脚本生成，可以 `source`：

```bash
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
set -a
source .data/dev-postgres/dev.env
set +a
node --env-file=.env scripts/migrate.ts
npm run build -w @aihot/web
```

迁移保留默认连接池，或设置 `DATABASE_POOL_MAX` 至少为 2，避免 [MS-006](known-issues.md#ms-006单连接池导致迁移永久等待)。首次迁移不需要执行 `seed.ts` 或导入示范信源。

随后按 [本地开发说明](local-development.md#2-启动开发站点) 在独立终端运行 API、worker 和 Web；在每个后端终端加载上述 **dev-postgres** 连接文件，不照抄旧机器的 `lan-postgres` 路径。Web 只配置 `API_BASE_URL` 和 `SITE_URL` 等前端所需地址，不加载数据库和模型凭证。默认开发网站为 `3000`、API 为 `3001`；Compose 网站模板使用 `3100`。端口冲突时同步调整网站地址。

模型使用 Chat Completions 兼容接口。已有频道任务读取数据库内冻结的模型配置；**修改 `.env` 的模型名不等于更新已有活动频道版本**。Key 和 Base URL 由环境提供，模型路由与规格、频道配额需要分别核对，流程见 [频道配置生命周期](multi-space-development.md#配置生命周期) 和 [DeepSeek 联调记录](reports/2026-10-23-deepseek-integration.md)。新库也不会自动继承旧库的开发配额。

## 4. 在新机器验证

在未加载真实供应商凭证的终端执行，先构建 Web 再测试：

```bash
npm run typecheck
npm run build -w @aihot/web
(
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
  set -a
  source .data/dev-postgres/test.env
  set +a
  COLLECT_ENABLED=true MODEL_CALLS_ENABLED=true FEISHU_INTERNAL_ENABLED=false npm test
)
FEISHU_INTERNAL_ENABLED=false npm run test:standalone
node --test apps/web/tests/*.test.ts
```

测试中的采集和模型仅连接本地假服务，真实飞书与 IndexNow 外发关闭。上述临时开关只属于测试进程，不修改开发环境文件。开发站点启动后再执行：

```bash
node scripts/smoke.ts --base http://127.0.0.1:3000
node scripts/mcp-check.ts http://127.0.0.1:3000/api/mcp
```

如果使用其他网站端口，两条命令都改为实际地址。需要继续 DEV-02 原型时，另按 [本地开发验证](local-development.md#3-验证) 使用 `proof.env`，不要换成运行库。

## 5. 在同一台 Mac 部署应用

完成开发验证后，按 [MacBook Pro 单机部署说明](macbook-deployment.md) 准备原生 PostgreSQL 17、独立运行库与权限，并从 `deploy/macbook.env.example` 建立私有 `.data/macbook/deploy.env`。

容器通过 `host.docker.internal:5432` 连接该 Mac 的运行库，本机工具使用 `127.0.0.1:5432`。不沿用旧开发服务器 `172.16.0.17`，也不把容器内的 `localhost` 当作宿主机。监听和 SCRAM 认证要按目标 Mac 的实际 Docker 网络验证。

```bash
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env check
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env deploy
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env status
```

`check` 不证明数据库可连接；`deploy` 会构建、停应用、备份、迁移并启动应用，执行前应核对目标库并停止其他连接该库的写入进程。它只运行 Web、API、worker 和临时 setup 容器，不管理 PostgreSQL 服务。API / worker 共享的文件卷和原生数据库分别备份；不要执行删除卷的清理命令。

当前 Compose 固定关闭采集、模型、飞书和 IndexNow，也不向容器传递相应凭证。把 DeepSeek Key 写入环境文件不会自动开启模型；真实业务启用需要后续调整部署白名单并分别验收。同一个 Docker daemon 上复用 `myhot-lan` 项目名及卷名，不会因为换了环境文件就形成另一套隔离部署。

若需要接续旧库数据，应先停止旧环境写入并排空 worker，取得数据库逻辑备份和共享文件归档，恢复后再迁移、读回频道配置和配额、验证并切换入口；不要同时运行新旧 worker。首次空库部署不需要迁移旧调试数据。主机重启后的 PostgreSQL、Docker Desktop、应用恢复顺序和数据持久化必须在目标 Mac 实测。

## 6. 接续工作的状态边界

- DEV-01～DEV-05 已实现多频道基础、采集处理上下文、统一网站及公开出口隔离、独立报告、推送订阅与配额；详见 [频道开发说明](multi-space-development.md)。
- [MS-001～MS-007](known-issues.md) 仍为 Open，其中包含 P1 的停用频道阻断全局恢复；本轮交接不代表这些问题已修复。
- 旧机已完成本地回归和一次真实 DeepSeek 请求、回执复用及配额检查；后者只是局部模型联调，不等于采集到发布、推送的业务闭环通过。
- 正式网络安全信源、业务规则、资产影响与处置流程仍需后续开发和验收。页面 `MyHOT` 是占位名称，默认行业示例不代表正式安全配置。
- Mac 部署模板和脚本已经准备；目标 Mac 的镜像构建、数据库连接、容器部署与重启恢复尚需实际验证。GKE 仍为方案，未完成云端发布。

新机器完成上述检查后，将实际提交、测试结果、数据库与部署验证边界记录到新的 `docs/reports/` 文件，再继续修复已知问题或推进业务接入。
