# 本地改动归档与 staging 验收

日期：2026-10-28，Asia/Shanghai。开发分支：`codex/source-dates-security-staging`。
应用实现提交：`1fd9ac1`、`06c4b18`、`15d427f`；staging 运行版本：`15d427f-staging`。

## 范围与归档

原运行目录 main 有 62 个修改文件和 2 个未跟踪文件；原 staging 开发目录有 55 个修改文件和 2 个未跟踪文件。
两个目录共同的 57 个文件内容完全一致。汇总运行目录独有的 7 个部署文件时保留已有 staging 文档入口。
先保存两份原始补丁、未跟踪源码及文件哈希，再整理为部署配置、安全采集适配、日期精度展示三个主题提交。
包含此前尚未合并到 main 的隔离 staging 基础设施提交。没有改变 main 指向或执行合并。

提交前验证的 Git tree 为 `391ec1d79b19a57fe9f8e549fb7cbbd02d0ea223`；三个实现提交的最终 tree 与此一致。
原运行目录的文件在清理前再次逐一核对哈希，无并发修改，且 prod 没有绑定挂载该源码目录。
已提交推送的改动从原 main 工作区移除，main 恢复干净；私有运行配置和数据未移动。
本次额外提交只记录验收文档，不改变已测试的应用源码。

## 实现

- 显式区分仅日期与准确时刻，贯通后台预览、文章、列表、事件、主题、收藏和结构化数据；真实收录与计算时间保留时刻。
- 淘汰旧日期精度浏览器快照；收藏仍兼容原存储结构，频道与未读状态保留。
- CISA KEV 按 CVE 读取目录事件，区分 dateAdded、原始披露及 FCEB 处置期限；首次限量导入、同日增量和既有更正分别处理。
- MSRC 使用官方 CSAF 逐 CVE 文档补正文与原发日期，RSS/Atom 的修订通知不充当公告正文或原发时间。
- RSS/Atom 增加显式正文日期和公告链接规则；JSON 列表可显式开启外部 ID 身份，保留已存身份复用。
- 归档本机实际使用的后端模型及频道 webhook 白名单与显式开关；安全频道使用独立引用，Web 不接收密钥。
- 未新增数据库迁移、导入来源、修改评分门槛或升级公开协议。

## Standards

评审发现一项 P2：Atom 分支使用 MSRC 适配时可能把长修订通知记为完整正文，跳过官方提取。
新增既有 RSS 测试文件中的 Atom 回归用例，先失败、修复后通过；Atom 现在清空正文并保持 pending。
同时将 LAN/staging Compose 纳入环境变量模板检查的实际部署证据，识别动态频道 webhook 引用。

React 检查覆盖条件 Hook、Effect、SSR/浏览器状态、缓存版本与频道边界，未发现新增问题。
已解决应用发现 1 项；最终未解决 Standards findings：0；历史最高级别 P2。

## Spec

`no spec available`：未找到对应的独立原始 PRD、需求单或 issue；已检查开发计划、已知问题和频道文档。
本轮按 `docs/sources.md`、日期解析精度约定、频道与浏览器状态约定及新增验收场景核对行为，未推断额外需求。
Spec findings：0；最高级别：无。没有宣称本轮关闭既有 MS-007 或完成安全筛选业务校准。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| 类型检查 | 通过 |
| 完整后端回归 | 1072/1072 |
| Web 构建与测试 | 构建通过，80/80，含 Chromium/WebKit |
| staging 隔离配置 | 3/3 |
| MSRC Atom 复现/修复回归 | 先失败，修复后 RSS 链接测试 10/10 |
| Git diff 与私有数据检查 | 通过；未提交 .data、凭据、hook 地址或私钥 |
| staging 部署后整站 smoke | 全部通过 |
| staging MCP 完整契约 | 通过，协议仍为 4.1.0 |
| staging 实际浏览器 | 桌面与手机、默认与安全频道页面均 200，无 pageerror |
| staging 管理员会话 | 匿名 401，独立密码登录、来源页与退出撤销通过 |

完整后端运行于临时 Node 24 测试容器和独立 `myhot_changes_20261028_test`，只使用本地假采集与模型服务。
没有把 staging 或 prod 当作测试库。临时测试容器已退出删除，测试管理员凭据文件已删除。

## 真实来源快照对比

仅下载公开官方订阅快照，再通过离线 MockAgent 比较 `ff760653` 与候选解析器；未写应用数据、调用模型或发送通知。

| 真实来源 | 条目数 | 变化及核对 |
| --- | --- | --- |
| Google Cloud Security Bulletins | 30 | 30 条从正文明确 Published 标签补出日精度日期；不使用 Atom updated 冒充原发 |
| Microsoft MSRC RSS | 5051 | 5051 条保留修订时间、原发未知并等待 CSAF，不把修订通知当完整公告 |
| GitHub Security RSS 对照 | 10 | 输出完全无变化 |
| CISA 官方 KEV 镜像 | 1760 | 全部具有有效日精度日期、唯一 CVE 身份和完整必填材料 |

另取 MSRC RSS 引用的官方 `CVE-2026-70277` CSAF 文档离线验证：输出正文 7847 字符，
原发日期为文档的 `2026-10-13T07:00:00.000Z`，与修订通知时间分离。
这些是解析正确性检查，不代表安全筛选准确率或公司资产影响评估。

快照来源：
- https://docs.cloud.google.com/feeds/google-cloud-security-bulletins.xml
- https://api.msrc.microsoft.com/update-guide/rss
- https://github.blog/security/feed/
- https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json
- https://msrc.microsoft.com/csaf/advisories/2026/msrc_cve-2026-70277.json

## staging 发布与隔离

发布前只停止 staging，成对备份其数据库和文件卷并校验归档可读性及 SHA-256。
备份目录为本 checkout 的 `.data/staging-backups/20261028-15d427f/`，目录 0700、文件 0600；保留旧环境配置和镜像可用于回退。
发布后迁移仍为 187 条，文章 4、来源 5、分析 4、回执 20、投递 0，两个既有频道的启用状态及活动配置版本完全一致。

三个 staging 服务 healthy，绑定仅 `127.0.0.1:3200`，数据库、账号、卷与网络保持专用。
采集、模型、飞书内容推送、飞书内部通知和 IndexNow 均为 false；外部 API key 与 webhook 值为空。
实际手机页面已核对日期源显示“10月26日”等日期，具备真实时刻的条目继续显示时分。

prod 保持本轮开始时的 `20261028-date-precision-prod`：API、worker、Web 的容器 ID、镜像 ID、启动时间逐一未变，健康检查通过。
本轮没有重启或发布 prod，也没有合并 main；staging 验证完成后由后续评审决定合并和生产发布。

原始补丁、测试输出、解析结果及浏览器截图保存在本机 `.data/change-review-20261028/`，不进入 Git。
