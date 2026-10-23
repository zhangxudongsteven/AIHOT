# MacBook Pro 单机部署：原生 PostgreSQL + 应用 Compose

更新：2026-10-23。当前短期目标是应用与数据库都运行在同一台 MacBook Pro，**PostgreSQL 独立安装和管理，不纳入 Compose**。长期迁移路线见 [GCP 部署方案](gcp-deployment-plan.md)。本文和配置模板已准备，尚未在目标 MacBook Pro 安装数据库或完成容器部署。

## 1. 运行边界

| 组件 | 运行位置 | 数据与生命周期 |
| --- | --- | --- |
| PostgreSQL 17 | Mac 原生服务，可由 Homebrew 管理 | 原生数据库目录，由数据库管理员管理；Compose 不启动、停止或删除它 |
| Web | Compose 常驻容器 | 网站入口；不接收数据库密码 |
| API / worker | Compose 两个常驻容器 | 共享 `myhot-lan_data` 命名卷中的 `/data` |
| setup | Compose 临时容器 | 连接宿主机 PostgreSQL，执行备份检查与 schema 迁移；不是数据库服务 |

复用 [compose.lan.yml](../compose.lan.yml) 和 [deploy-lan.sh](../scripts/deploy-lan.sh)，不引入第二份 Compose。项目名仍为 `myhot-lan`，卷名仍为 `myhot-lan_data`；在同一个 Docker daemon 上，切换环境文件不是创建另一套隔离实例。

迁移和备份仍会连接数据库进行授权操作。“数据库不纳入 Compose”指数据库服务及其原生数据目录不由 Compose 管理，不表示应用发布不执行数据库迁移。

## 2. 在目标 Mac 准备原生数据库

先检查该 Mac 是否已有 PostgreSQL，以及 5432 是否被占用；已有实例时核对版本、数据目录和管理方式。以下是**目标 Mac 上首次安装**的示例，不是在当前开发电脑上自动执行的操作。

```bash
brew install postgresql@17
brew services start postgresql@17
```

Homebrew 提供版本化的 PostgreSQL 17，并由上述服务命令启动、在登录时启动。实际芯片与 macOS 版本需要符合安装要求；已有数据库不要重复初始化数据目录。[Homebrew 官方 formula](https://formulae.brew.sh/formula/postgresql%4017)

首次创建专用账号和空库时，在该数据库管理员身份下运行；以下命令按 Homebrew 默认本机管理方式编写，已有同名账号/数据库应先核对用途，不重复创建：

```bash
MYHOT_PG_BIN="$(brew --prefix postgresql@17)/bin"
"$MYHOT_PG_BIN/createuser" --pwprompt --no-superuser --no-createdb --no-createrole myhot
"$MYHOT_PG_BIN/createdb" --owner=myhot myhot
```

密码交互输入，再保存在本部署的私有环境文件中。应用账号拥有该库，用于历史迁移、`pg_trgm` 和 pg-boss schema 初始化；在实际部署前验证权限。应用运行不需要为该账号授予测试框架使用的 `CREATEDB`。测试另用以 `_test` 或 `_ci` 结尾的库和合适账号，不连接运行库。

通过数据库管理员连接查询 `SHOW data_directory`、`SHOW config_file`、`SHOW hba_file` 确定实际位置，不在文档中固定 `/opt/homebrew` 或 `/usr/local`。原生数据库目录不放在代码 checkout、`.data/` 或 Docker 数据卷里，也不挂载进应用容器。

## 3. 容器如何连接宿主机

| 调用方 | 数据库地址 |
| --- | --- |
| Mac 原生 `psql` / 管理工具 | `127.0.0.1:5432`，或实例配置的 Unix socket |
| API、worker、setup 容器 | `host.docker.internal:5432` |

Docker Desktop 为容器提供 `host.docker.internal`，用于访问宿主机服务。容器中的 `localhost` 是容器自身；不把 PostgreSQL 地址写成 `api`、`db` 或旧的 `172.16.0.17`。[Docker 官方网络说明](https://docs.docker.com/desktop/features/networking/networking-how-tos/)

数据库的监听与认证配置还需独立验证：

- 查询 `SHOW listen_addresses`、`SHOW port`，先测试当前监听是否能接收 Docker Desktop 转发的连接；不假定每种 Docker 网络配置都等同宿主机 loopback。
- 若连接被拒绝，核对实际目标接口、数据库监听和主机防火墙，再开放必要的本机接口；不直接套用 `listen_addresses='*'`。监听设置改变需要重启 PostgreSQL。
- `pg_hba.conf` 按数据库 `myhot`、用户 `myhot` 和数据库实际看到的客户端来源配置 `scram-sha-256`。规则按顺序匹配，应检查前面的通用 `trust` 规则是否抢先命中。Docker 的虚拟网络及来源可能变化，不照抄其他机器的固定子网。
- 验证密码认证，并测试错误密码确实被拒绝；不要用全网 `trust` 消除连接错误。数据库只服务本机应用时，不需要将 5432 发布给局域网用户。

监听和认证是两项独立配置，参见 [PostgreSQL 监听参数](https://www.postgresql.org/docs/17/runtime-config-connection.html)及 [pg_hba.conf](https://www.postgresql.org/docs/17/auth-pg-hba-conf.html)。如果容器运行环境不是 Docker Desktop，先核验其宿主机访问方式，再调整连接地址。

## 4. 配置应用

在目标 Mac 的项目目录准备独立环境文件，保留既有 `.env` 和 `.env.lan`：

```bash
umask 077
mkdir -p .data/macbook
chmod 700 .data/macbook
test -e .data/macbook/deploy.env || cp deploy/macbook.env.example .data/macbook/deploy.env
chmod 600 .data/macbook/deploy.env
```

编辑这个私有文件，填写 `PGPASSWORD`、至少 12 位的 `ADMIN_PASSWORD`、`SESSION_SECRET` 和 `IMG_PROXY_SIGN_SECRET`。模板中的密码与密钥为空；不要把填好的文件留在 `deploy/` 或提交 Git。`.data/` 已从 Docker 构建上下文排除。

默认连接与网站配置：

```dotenv
DATABASE_URL=postgres://myhot@host.docker.internal:5432/myhot
DATABASE_POOL_MAX=4
SITE_URL=http://localhost:3100
PORT=127.0.0.1:3100
```

`PGPASSWORD` 单独填写，不拼入 URL。默认网站仅供本机验证；给公司局域网访问时，将 `SITE_URL` 改成 `http://<Mac固定局域网IP>:<可用端口>`，将 `PORT` 改成同一个 `<IP>:<端口>`，并核验主机防火墙。网站地址不能使用 `host.docker.internal`。容器内仍由 Web 监听 3000、API 监听 3001，数据库地址不随网站地址改变。

当前 Compose 中采集、模型、飞书和 IndexNow 固定为关闭，且不传入相关凭据；更改环境文件不会开启它们。先验收单机运行，后续再修改部署白名单、开关及配额，逐项验证真实业务。

## 5. 部署与验证

先确保原生 PostgreSQL 和 Docker Desktop 正常运行。停止其他连接目标库的 API、worker 或导入程序，避免迁移时继续写入；原有 `172.16.0.17` 开发库保持独立。

```bash
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env check
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env deploy
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env status
```

`check` 只验证 Compose 配置与 Docker daemon，不验证数据库连接。`deploy` 会构建镜像、从容器只读检查 PostgreSQL 连接和 `pg_dump` 兼容性，再依次停止应用、备份数据库及文件、执行迁移、启动三个应用容器并检查网站/MCP。数据库版本、扩展和历史迁移是否兼容，以实际执行结果为准；不导入示范信源。

打开 `http://localhost:3100` 验证网站和 `/admin`。再确认宿主机 PostgreSQL 没有变成 Compose 服务、API / worker 共享文件可见、重建应用容器后文件仍在、外部动作仍关闭。主机重启后须验证原生数据库、Docker Desktop、应用恢复顺序以及 worker 心跳；Compose 的重启策略不负责启动宿主机数据库或 Docker Desktop。Mac 服务机还应持续供电、保持网络、配置休眠策略。

停止本应用：

```bash
bash scripts/deploy-lan.sh --env-file .data/macbook/deploy.env stop
```

该命令不停止原生 PostgreSQL，也不删除数据库或共享卷。数据库服务由其原生管理方式单独运维。

## 6. 备份与迁移到 GCP

部署脚本将停写后的数据库逻辑备份和应用文件归档保存在 `.data/lan-backups/`。这是部署时备份，不是周期备份；正式试运行前需要安排独立的定期备份、异机副本和恢复演练。数据库原生目录、Docker 卷、备份文件是三种不同内容，清理项目或容器前要分别核对。

迁移到 GCP 时采用：停止新写入并排空旧应用 → 最终逻辑备份与文件归档 → 恢复到目标 PostgreSQL 和持久化卷 → 以目标架构镜像执行必要迁移 → 读回活动频道配置、配额与凭据引用 → 验证后切换入口。保留旧环境用于核对时不要同时运行它的 worker。

PostgreSQL 使用逻辑备份迁移，不直接复制 macOS 数据目录到 Cloud SQL；应用共享文件单独恢复。密码和签名密钥另行迁移到 Secret，频道配置快照和配额随数据库迁移。Mac 为 Apple Silicon 而 GKE 为 amd64 时，从相同源码为目标架构重新构建镜像。具体云端发布约束见 [GCP 方案](gcp-deployment-plan.md)。
