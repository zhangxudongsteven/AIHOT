# 本地开发与基线检查

DEV-01 在 2026-10-23 完成。使用 Node.js 24.22.1、PostgreSQL 17 和 npm workspaces；不依赖 Docker daemon。具体结果见 [DEV-01 / DEV-02 验证记录](reports/2026-10-23-dev01-dev02.md)。DEV-03/04 的配置版本、频道阅读、迁移切换及当前功能边界见[频道开发说明](multi-space-development.md)。

当前开发版本为公开接口 4.1.0；最近一次复核见[评审与版本记录](reports/2026-10-23-review.md)。[已知问题](known-issues.md)尚未修复，包括迁移进程在 `DATABASE_POOL_MAX=1` 时等待自身持有的连接；开发迁移保留默认连接池或设置为至少 2。

新机器先按[接续开发与部署说明](new-machine-setup.md)准备环境。当前短期部署目标见 [MacBook Pro 原生数据库与应用 Compose](macbook-deployment.md)；以下局域网连接记录属于原工作机，不会随 Git 自动配置到新机。只调页面时可让本机 Web 连接已运行的服务器 API；调后端时避免两套 worker 共用一个开发库。

## 1. 准备工具和数据库

### 局域网数据库（当前开发环境）

原工作机开发和测试使用 `172.16.0.17:5432`，数据库账号为 `myhot`。开发库是 `myhot`；该工作机的测试模板单独使用 `myhot_macbook_air_test`，不能把开发库用于测试。2026-10-23 数据库接入阶段核验服务端为 PostgreSQL 17.11、187 项迁移，当时文章和模型回执均为 0；后续 DeepSeek 联调新增了 1 条回执，见[独立记录](reports/2026-10-23-deepseek-integration.md)。管理员已授予建库权限，测试框架成功创建并迁移了独立测试模板。

局域网环境完整后端回归 1025/1025、Web 回归 66/66 通过，实际 API/worker/Web 的 smoke 与 MCP 检查也已通过；测试克隆库已清理，开发库计数与测试前一致。详见[本轮验证记录](reports/2026-10-23-lan-postgres.md)。

本 checkout 的私有配置如下，均被 Git 忽略，文件权限为 0600：

| 文件 | 用途 |
| --- | --- |
| `.env` | 默认开发连接，保留已有应用身份配置 |
| `.data/lan-postgres/dev.env` | 显式切换到局域网开发库，并关闭采集、模型、飞书和 IndexNow 外发 |
| `.data/lan-postgres/test.env` | 独立测试库连接，关闭飞书和 IndexNow 外发；不加载应用密钥 |

`DATABASE_URL` 只包含地址、账号和库名，例如 `postgres://myhot@172.16.0.17:5432/myhot`；密码单独放在 `PGPASSWORD` 环境变量中。不要打印或提交私有文件，也不要把密码复制进命令行连接地址。其他工作机需要自行创建对应私有文件；测试模板应使用各自独立的名字，并以 `_test` 或 `_ci` 结尾。

当前账号已实测具备 `CREATEDB`，不是超级用户。现有测试框架会连接同一服务器的 `postgres` 库、自动创建测试模板，再为每个测试文件创建独立克隆库。新的开发账号需要由数据库管理员授予相应权限，例如：

```sql
ALTER ROLE myhot CREATEDB;
```

账号还需能连接 `postgres`，并拥有自己的测试模板和克隆库。同一测试模板不要同时启动多轮测试：测试框架会清理该模板前缀的克隆库。它不会清理开发库 `myhot`，也不要使用其他开发者的模板名。

局域网连接不需要启动本机 PostgreSQL 服务。备份/恢复测试仍需 PostgreSQL 17 的 `pg_dump` 和 `pg_restore` 客户端；安装和路径设置见下面的本机说明。DEV-02 实验明确只允许 loopback 数据库，仍使用本机 `proof.env`。

### 本机数据库（离线开发及 DEV-02 实验）

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
# 首次克隆才需要 npm ci；当前开发目录已安装。

# macOS/Homebrew，缺少 PostgreSQL 17 时执行；无需 brew services start。
brew install postgresql@17
export PG_BIN="$(brew --prefix postgresql@17)/bin"
export PATH="$PG_BIN:$PATH"
bash scripts/dev-database.sh start
```

Intel Mac 的默认目录为 `/usr/local/opt/postgresql@17/bin`，常见 Linux 包安装目录为 `/usr/lib/postgresql/17/bin`；其他位置显式设置 `PG_BIN`。脚本检查服务端主版本为 17，测试和备份工具也使用同一目录，避免误用系统中其他版本的 `pg_dump` / `pg_restore`。

脚本只管理本 checkout 的 `.data/dev-postgres/data`，不使用 `DATABASE_URL`、系统数据库服务或公司数据库。实例固定监听 `127.0.0.1:55432`，禁用 Unix socket，使用随机密码及 SCRAM；首次启动创建 `aihot_dev`、`aihot_test`、`aihot_space_test` 三个独立库。若端口被其他服务占用，启动失败，不会接管或停止对方服务。

私有连接文件位于 `.data/dev-postgres/{dev,test,proof}.env`，权限 0600，均被 Git 忽略；不要打印或提交其内容。开发连接文件还关闭采集、模型、飞书、IndexNow，限定本机端口和项目文件目录。此账号是本地开发管理员，不适用于生产权限设计。

```bash
bash scripts/dev-database.sh status
# 先停止使用此数据库的项目进程，再执行：
bash scripts/dev-database.sh stop
```

`stop` 不删库、不删文件；重复 `start` 保留已有数据。未设置系统开机启动。PostgreSQL 需要本地监听和共享内存权限；受限执行环境应允许这两项，而非修改数据库保护规则。

## 2. 启动开发站点

首次克隆没有 `.env` 时，按上游文档运行 `node scripts/init-env.ts` 生成本地身份密钥。已有 `.env` 不要覆盖。本机已配置用户提供的 TokenHub DeepSeek 凭证，并完成一次真实请求、回执复用及配额验证，见 [DeepSeek 联调记录](reports/2026-10-23-deepseek-integration.md)；常驻模型开关仍为 `false`。不要把 `.env` 当作 shell 脚本 source；其中模型 JSON 配置未必符合 shell 语法。

在每个项目终端先执行以下公共准备；下面的数据库连接文件可使用 shell source，应用 `.env` 仍由 Node 读取：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
export PG_BIN="$(brew --prefix postgresql@17)/bin"
export PATH="$PG_BIN:$PATH"
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
set -a
source .data/lan-postgres/dev.env
set +a
```

导出的开发配置优先于 Node 后续读取的 `.env`，因此使用局域网开发库及关闭的外发开关。切回本机库时改为加载 `.data/dev-postgres/dev.env`；不要只更换 `--env-file` 而保留终端中已导出的旧 `DATABASE_URL` / `PGPASSWORD`。默认不导入 AI 示例源或真实安全源；真实源的选择在业务阶段确认。

```bash
node --env-file=.env scripts/migrate.ts
npm run build -w @aihot/web
```

在三个独立终端完成上述公共准备后，分别启动：

```bash
# 终端 1：API，127.0.0.1:3001
npm run dev:api

# 终端 2：worker，开发库中的队列和调度
npm run dev:worker

# 终端 3：Web，127.0.0.1:3000
npm run dev:web
```

本机 3000 端口已被其他项目使用时，可将本站 Web 改到 3100，API 仍用 3001。2026-10-23 本轮调试采用这组端口。API 和 worker 的终端先完成上面的公共准备，再分别运行：

```bash
SITE_URL=http://127.0.0.1:3100 npm run dev:api
SITE_URL=http://127.0.0.1:3100 npm run dev:worker
```

Web 使用一个只配置前端所需地址的新终端，不加载数据库及模型凭证：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
API_BASE_URL=http://127.0.0.1:3001 SITE_URL=http://127.0.0.1:3100 \
  npm exec -w @aihot/web -- react-router dev --port 3100 --host 127.0.0.1
```

打开 `http://127.0.0.1:3100/` 和 `http://127.0.0.1:3100/admin`；后台使用私有 `.env` 的 `ADMIN_PASSWORD` 登录。启动另一组进程前先确认端口和 worker 心跳，避免重复启动。开发命令支持代码自动重载，结束时在各自终端按 Ctrl+C。采集、模型和推送开关仍关闭，空开发库显示空内容是正常状态。

生产构建的本地验证使用同一套导出配置：API/worker 分别运行 `NODE_ENV=production node --env-file=.env apps/api/src/main.ts`、`NODE_ENV=production node --env-file=.env apps/worker/src/main.ts`；Web 在 `apps/web` 目录运行 `NODE_ENV=production node --env-file=../../.env server.ts`。它们仍只监听本机且外发关闭，`production` 在此用于检查生产模式启动行为，不表示已部署生产。

结束时在各终端停止对应进程；先让 worker 正常排空，再停止数据库。空开发库没有文章，定时补刊可能记录 `nothing judged in its window`；这不代表采集或真实出刊已验收，也不应为让日志变绿而伪造新闻。

## 3. 验证

先构建 Web，再跑依赖 SSR 产物的测试。完整后端测试不读取应用 `.env`；在子 shell 中加载专用测试连接，结束后不改变当前终端的开发库连接。

```bash
npm run typecheck
npm run build -w @aihot/web
(
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
  set -a
  source .data/lan-postgres/test.env
  set +a
  COLLECT_ENABLED=true MODEL_CALLS_ENABLED=true FEISHU_INTERNAL_ENABLED=false npm test
)
node --test apps/web/tests/*.test.ts
```

测试框架按每个文件复制/清理独立测试库，账号需要建库权限；模板必须以 `_test` / `_ci` 结尾。测试中的采集和模型行为仅连接本地假服务，飞书与 IndexNow 外发关闭。不要将运行数据库连接替换进测试命令。

站点启动后：

```bash
node scripts/smoke.ts --base http://127.0.0.1:3000
node scripts/mcp-check.ts http://127.0.0.1:3000/api/mcp
```

DEV-02 原型独立于根目录测试，单独执行：

```bash
node node_modules/typescript/bin/tsc -p experiments/multi-space
env -u MULTI_SPACE_DATABASE_URL node --env-file=.data/dev-postgres/proof.env --test experiments/multi-space/proof.test.ts
```

迁移检查继续使用 `node scripts/check-migrations.ts --base <变更前的Git引用>`。CI 文件已核对：包含 PostgreSQL 17、完整测试、smoke/MCP 和 Compose 检查，并新增独立的 `Multi-space design proof` 步骤。本地通过不等于 GitHub Actions 已运行。本次未启动 Docker 或触发远程 CI。
