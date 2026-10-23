# 本地开发与基线检查

DEV-01 在 2026-10-23 完成。使用 Node.js 24.22.1、PostgreSQL 17 和 npm workspaces；不依赖 Docker daemon。具体结果见 [DEV-01 / DEV-02 验证记录](reports/2026-10-23-dev01-dev02.md)。DEV-03/04 的配置版本、频道阅读、迁移切换及当前功能边界见[频道开发说明](multi-space-development.md)。

当前开发版本为公开接口 4.1.0；最近一次复核见[评审与版本记录](reports/2026-10-23-review.md)。[已知问题](known-issues.md)尚未修复，包括迁移进程在 `DATABASE_POOL_MAX=1` 时等待自身持有的连接；开发迁移保留默认连接池或设置为至少 2。

## 1. 准备工具和数据库

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
# 首次克隆才需要 npm ci；当前开发目录已安装。

# macOS/Homebrew，缺少 PostgreSQL 17 时执行；无需 brew services start。
brew install postgresql@17
export PG_BIN=/opt/homebrew/opt/postgresql@17/bin
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

首次克隆没有 `.env` 时，按上游文档运行 `node scripts/init-env.ts` 生成本地身份密钥。已有 `.env` 不要覆盖。本次准备已经生成 `.env`，且没有真实 LLM Key。不要把 `.env` 当作 shell 脚本 source；其中模型 JSON 配置未必符合 shell 语法。

在每个项目终端先执行以下公共准备；只有由本地数据库脚本生成的文件才使用 shell source：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
export PG_BIN=/opt/homebrew/opt/postgresql@17/bin
export PATH="$PG_BIN:$PATH"
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
set -a
source .data/dev-postgres/dev.env
set +a
```

导出的开发配置优先于 Node 后续读取的 `.env`，因此保留本地数据库地址及关闭的外发开关。默认不导入 AI 示例源或真实安全源；真实源的选择在业务阶段确认。

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
  source .data/dev-postgres/test.env
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
