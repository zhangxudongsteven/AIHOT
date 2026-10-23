# 局域网调试部署

当前短期目标已调整为应用与原生 PostgreSQL 同机运行在 MacBook Pro，见 [Mac 单机部署说明](macbook-deployment.md)。该方案复用本页的 Compose 和脚本，使用独立 Mac 环境模板；以下 `172.16.0.17` 配置保留为原局域网服务器方案，不代表 Mac 的部署地址。

目标服务器为 `172.16.0.17`，复用已存在的 PostgreSQL 17 和 `myhot` 开发库。代码继续在本机开发，服务器运行 Web、API 和 worker。本配置不启动 PostgreSQL，不导入示范信源。

部署文件已准备，验证范围和待服务器执行的步骤见[验证记录](reports/2026-10-23-lan-deployment.md)。本地测试通过不代表已经远程部署。

## 配置与数据

使用独立的 `compose.lan.yml`，不要与原 `docker-compose.yml` 合并执行。Compose 项目名为 `myhot-lan`，应用文件存放在独立的 `myhot-lan_data` 卷。只发布网站端口 `172.16.0.17:3000`；API 仅供容器内 Web 访问。

服务器需要 Docker Engine、支持 `up --wait` 的 Docker Compose、Bash 和 tar；不需要在宿主机安装 Node.js 或 npm。数据库客户端随应用镜像提供。容器必须能够访问 `172.16.0.17:5432`；部署脚本会在停止旧应用前验证连接。首次构建需要能下载基础镜像和依赖。

```bash
umask 077
test -e .env.lan || cp deploy/lan.env.example .env.lan
chmod 600 .env.lan
# 编辑 .env.lan，填写 PGPASSWORD、ADMIN_PASSWORD 和两项签名密钥。
```

本 checkout 已准备好私有 `.env.lan`，使用现有数据库密码，并生成独立的服务器管理员密码与签名密钥；不要用上面的复制命令覆盖它。部署时将该文件单独安全传到服务器，不提交 Git、不打包进镜像，不直接 source。其他环境从无密码模板自行初始化。每项随机密钥可分别用 `openssl rand -hex 32` 生成；管理员密码至少 12 位。

| 配置 | 当前用途 |
| --- | --- |
| `DATABASE_URL` | `postgres://myhot@172.16.0.17:5432/myhot`，地址中不含密码 |
| `PGPASSWORD` | 数据库密码，单独的私有环境变量 |
| `DATABASE_POOL_MAX` | 默认 4，当前迁移要求至少 2 |
| `SITE_URL` | `http://172.16.0.17:3000`，用于公开链接与 MCP 主机校验 |
| `PORT` | `172.16.0.17:3000`，宿主机绑定地址和端口；换端口时同步修改 `SITE_URL` |
| `ADMIN_PASSWORD` | 本次服务器部署的管理员登录密码 |
| `SESSION_SECRET` / `IMG_PROXY_SIGN_SECRET` | 两项独立签名密钥 |
| `AIHOT_RELEASE` | 部署标识，同时用于镜像标签；填写可定位到源码的版本名 |

后端仅接收 Compose 白名单中的环境变量，Web 不接收数据库或管理员密钥。采集、模型、飞书内部消息、内容推送和 IndexNow 的开关在 Compose 中固定为 `false`；修改 `.env.lan` 或终端的同名变量不会开启它们。开发免登录、模型与采集服务密钥、飞书凭证和备份云存储凭证均不传入容器。开启真实业务另行变更配置并验证。

## 部署与更新

把本项目源码放到服务器专用目录，例如 `/opt/myhot/app`。按[新机器说明](new-machine-setup.md)获取 `codex/prepare-development` 分支，核对提交和部署文件；不要误用仍停留在旧基线的默认分支。本机 `node_modules`、`.data`、构建缓存和私有环境文件不随源码复制。`.env.lan` 单独放在服务器项目根目录，权限保持 0600。

首次部署和后续更新均在服务器的项目目录执行：

```bash
bash scripts/deploy-lan.sh check
bash scripts/deploy-lan.sh deploy
bash scripts/deploy-lan.sh status
```

使用其他私有配置文件时传入 `--env-file /绝对路径/配置文件`，文件必须放在仓库外，或被构建忽略的仓库 `.data/` 中。仓库内其他位置会被拒绝，避免 Docker 的 `COPY . .` 将密码带进镜像；环境文件也不能是符号链接。脚本显式选择 LAN Compose 文件和项目，配置文件中的值优先于终端残留的应用变量。不要直接输出完整的 `docker compose config`，其中含有展开后的密钥。

部署前停止其他连接同一个 `myhot` 库的本机 API/worker，避免迁移期间仍有写入。尤其不要同时运行本机与服务器 worker：它们共享任务和 `heartbeat.worker` 记录，服务器健康检查会核对心跳归属。

部署脚本先构建镜像、检查数据库连接与必要配置，再停止旧应用、生成数据库和文件卷备份、执行迁移，最后启动三个应用服务并等待健康检查。初始化只运行 `scripts/migrate.ts`。备份放在项目的 `.data/lan-backups/`，目录权限受限，不自动删除；清理或迁移这个项目目录时保留备份。

构建或预检查失败时旧服务保持运行；停止旧应用后备份、迁移或启动失败，脚本返回失败，不自动回滚数据库。先检查错误再重跑，不能将“脚本已开始”当作部署成功。备份检查包括 dump 目录和文件归档的可读性，不等同于实际恢复演练；含数据的正式升级仍需核验恢复路径。

脚本不会执行频道约束切换。启用非默认频道前，仍按[频道升级约定](multi-space-development.md)完成备份、停止所有写入方，再显式执行 `space-cutover.ts`；迁移完成不代表此步骤已完成。

```bash
bash scripts/deploy-lan.sh logs
bash scripts/deploy-lan.sh stop
```

`stop` 只停止本项目应用，不停止现有 PostgreSQL、不删除数据卷。worker 保留最长 515 秒的正常退出窗口。

## 部署后的检查

脚本会在 Web 容器内执行 `scripts/smoke.ts`，检查主要页面、公开出口和 MCP 握手。从本机再验证局域网访问及完整 MCP 合约：

```bash
node scripts/smoke.ts --base http://172.16.0.17:3000
node scripts/mcp-check.ts http://172.16.0.17:3000/api/mcp
```

访问 `http://172.16.0.17:3000`，后台位于 `/admin`。空开发库没有文章是正常状态，不应为了让页面有内容而开启真实采集或导入未经确认的示范源。

## 随后的本机调试

改页面时，可以只在本机启动 Web 热更新，通过服务器的网站入口访问 API：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use
API_BASE_URL=http://172.16.0.17:3000 npm run dev:web
```

打开 `http://127.0.0.1:3000`。本机 Web 不需要数据库密码；这一步要求服务器已经部署成功。页面上的正式链接仍以服务器配置的 `SITE_URL` 为准。

需要调试 API/worker 时，先停止服务器上的应用，再按[本地开发说明](local-development.md)启动本机完整栈，继续保持外发关闭。如需两套后端同时运行，应使用不同开发库和各自文件目录；完整测试始终使用独立的 `*_test` 模板，不能使用 `myhot`。
