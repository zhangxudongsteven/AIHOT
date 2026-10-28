# 六个上游修复的本地整合

日期：2026-10-28（Asia/Shanghai）。目标仓库为 zhangxudongsteven/AIHOT，本地基线 `5ddd590f0e214d4a0b1ca26fe5b3cc89e8243ef2`，上游比较基线 `b3998dc6fc138eb9659f33f55eb38c1c716f0d57`。本次只选择六个修复，暂缓飞书告警 webhook 提交 `aa8e5b1`；没有新增环境变量、迁移、依赖或公开协议变化，未部署生产或 staging。

## 来源与本地适配

| 来源提交 | 原作者 | 引入原因与适配 |
| --- | --- | --- |
| [58168ec](https://github.com/KKKKhazix/AIHOT/commit/58168ecb92c5911c35d501c4cb0c9a2c2bd6b257) | Kay | 事件、主题及日期戳跨年带年份；Web 格式化 helper 同时保留 `isValidDate`、`publicationValue`、`timelineValue`、`clockTime`，不覆盖频道路由及元信息。 |
| [21e5c03](https://github.com/KKKKhazix/AIHOT/commit/21e5c036b3f91cf8327d4ba3c03aa2282092488d) | Kay | 明确的日期选择器在绝对日期失败后读取相对日期；保留本地 `PublicationDate` 契约。 |
| [ed4cbd1](https://github.com/KKKKhazix/AIHOT/commit/ed4cbd1c2a874e43e455c6c4ad8f0bb89888f28d) | 数字生命卡兹克 | 超过一天的小时数仍保留时刻，避免 `47小时前` 被切成日精度。 |
| [ce83484](https://github.com/KKKKhazix/AIHOT/commit/ce8348477438cce2b417c1403290a511c812a7c5) | 数字生命卡兹克 | 补齐今天/昨天时刻、作者前缀、英文短单位；不推断裸时刻、缺年日期或正文任意描述。 |
| [04427b9](https://github.com/KKKKhazix/AIHOT/commit/04427b98d7f6fb3e56e58e8ef3cba6a7c6740a4c) | Rahul Ranjan / rahul05ranjan | 日报切换、相邻期链接和跟进徽章跨年带年份，沿用频道内链接。 |
| [79d962e](https://github.com/KKKKhazix/AIHOT/commit/79d962ea96c7f2ed0d2df9b01d9cf00b5550d1d0) | Rahul Ranjan / rahul05ranjan | 识别 Devise、WordPress 及带扩展名的登录路径；额外要求完整扩展名后的路径边界，`/login.php-guide`、`/auth.html5` 仍作为普通内容。 |

原提交中的共同署名保留在整合提交说明。测试并入既有来源、正文提取和日期测试文件，没有另建一次性回归文件。已有 MS-002、MS-004、MS-007 不在本次修复范围，继续保持 Open。

## 验证

验证使用独立工作树、Node 24.22.1 及临时 PostgreSQL 17；运行库和 staging 不作为测试库，采集和模型只连接本地假服务，外部推送关闭。真实公开样本只作冻结输入重放，不注册来源、不入库或调模型。

定向回归已确认相对日期与登录链接在修复前失败、修复后通过；Web 日期、日报切换和相邻日期也逐项完成失败复现。

| 最终检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build -w @aihot/web` | 通过 |
| 独立 `myhot_upstream_20261028_test` 模板上的 `npm test` | 1095/1095，通过；每个文件使用自己的克隆库 |
| `npm run test:standalone` | 254/254，通过；这些用例与完整后端套件有重叠，不累加为独立覆盖 |
| `node --test apps/web/tests/*.test.ts` | 99/99，通过 |
| 完整日期解析模块在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下定向复验 | 各 27/27，通过 |
| Web 日期用例在上述两个时区下复验 | 各 10/10，通过 |
| `scripts/smoke.ts` | 30 项通过 |
| `scripts/mcp-check.ts` | 全部 7 工具、错误及边界输入通过，协议仍为 4.1.0 |
| 默认 / security × 事件 / 主题 / 日报 × 桌面 / 手机浏览器验收 | 12/12，通过 |
| 独立 Standards / Spec 评审 | 两轴各 0 findings；差异检查通过 |

后端在 Node 24.22.1 / PostgreSQL 17.11 的独立测试容器执行，容器没有外网或运行卷；smoke 在同一隔离环境启动 API、Web，不启动 worker，文章/回执/投递在前后均为 0。宿主同样使用 Node 24.22.1 运行类型、构建及 Web 检查。测试 PostgreSQL、依赖卷和临时进程已清理，prod/staging 未变更。

首轮完整后端有 16 项失败：15 项因为启动检查时尚未生成 Web SSR 产物，1 项因为新增重定向夹具的请求 URL 自身包含登录路径，按原有“已在登录地址上不算重定向”规则返回正文。生成构建、改为中性编号入口映射目的路径后，完整重跑 1095/1095 通过。另类型检查发现测试钩子上下文类型不提供 `mock`，改用 Node 自带的 mock 时钟并在每项测试后重置。未修改业务断言或放宽产品逻辑来通过验证。

浏览器验收固定服务端和浏览器时钟为 2027-01-02，使用本地合成 API 数据及真实生产 SSR。检查跨年年份、仅日期不出现时分、真实时刻仍显示 09:15、频道内链接和 canonical、手机日报切换、前刊与跟进徽章；12 页均无脚本或 SSR 错误。关键桌面与手机截图已目视检查。

## 真实公开样本对比

取样时间：2026-10-28 14:07–14:08（Asia/Shanghai）。基线为完整 `5ddd590` 导出，workspace 别名独立解析到基线，防止误用候选实现。对同一份冻结字节和读取时刻，以真实 `fetchRss`、`fromHtml`、`fetchDetail`、`extractFromUrl` 重放，MockAgent 禁止外网。

| 样本 | RSS / 列表条数 | 变化条数 | 判定 |
| --- | ---: | ---: | --- |
| [OpenAI RSS](https://openai.com/news/rss.xml) | 1331 | 0 | 输出哈希一致 |
| [Simon Willison Atom](https://simonwillison.net/atom/everything/) | 30 | 0 | 输出哈希一致 |
| [Spring Security 列表](https://spring.io/security/) | 25 | 0 | 输出一致，保留仅日期精度 |
| [创业邦列表](https://www.cyzone.cn/)（额外回归样本） | 32 | 15 | 相对日期由未知恢复，17 条绝对日期不变 |
| 合计 | 1418 | 15 | 15 条变化全部符合预期，其余 1403 条保持一致 |

15 条恢复日期逐一与页面 Nuxt 数据中独立发布 epoch 核对，误差均小于 60 秒，最大 58 秒，符合分钟级标签精度。详情再验证了同一篇文章的 `DoNews·9分钟前` 从未知恢复，未重复计作独立文章；读取时刻回推的秒数不代表原文声明了秒级发布时间。

| 变化文章 | 原始日期元素 | 候选 publicationTime | 与独立 epoch 的差（秒） |
| --- | --- | --- | ---: |
| [851007](https://www.cyzone.cn/article/851007.html) | 8分钟前 | 2026-10-28T05:59:18.187Z | 4.187 |
| [850956](https://www.cyzone.cn/article/850956.html) | 34分钟前 | 2026-10-28T05:33:18.187Z | 49.187 |
| [850981](https://www.cyzone.cn/article/850981.html) | 今天 11:34 | 2026-10-28T03:34:00.000Z | 28 |
| [850955](https://www.cyzone.cn/article/850955.html) | 今天 11:30 | 2026-10-28T03:30:00.000Z | 22 |
| [850968](https://www.cyzone.cn/article/850968.html) | 今天 11:30 | 2026-10-28T03:30:00.000Z | 18 |
| [850738](https://www.cyzone.cn/article/850738.html) | 今天 11:00 | 2026-10-28T03:00:00.000Z | 58 |
| [850943](https://www.cyzone.cn/article/850943.html) | 今天 10:50 | 2026-10-28T02:50:00.000Z | 31 |
| [850935](https://www.cyzone.cn/article/850935.html) | 今天 10:49 | 2026-10-28T02:49:00.000Z | 32 |
| [850934](https://www.cyzone.cn/article/850934.html) | 今天 10:37 | 2026-10-28T02:37:00.000Z | 41 |
| [850928](https://www.cyzone.cn/article/850928.html) | 今天 10:17 | 2026-10-28T02:17:00.000Z | 44 |
| [850926](https://www.cyzone.cn/article/850926.html) | 今天 10:07 | 2026-10-28T02:07:00.000Z | 43 |
| [850925](https://www.cyzone.cn/article/850925.html) | 今天 10:05 | 2026-10-28T02:05:00.000Z | 25 |
| [850924](https://www.cyzone.cn/article/850924.html) | 今天 09:49 | 2026-10-28T01:49:00.000Z | 36 |
| [850911](https://www.cyzone.cn/article/850911.html) | 今天 09:41 | 2026-10-28T01:41:00.000Z | 24 |
| [850901](https://www.cyzone.cn/article/850901.html) | 今天 09:38 | 2026-10-28T01:38:00.000Z | 37 |

[GNOME GitLab 登录页](https://gitlab.gnome.org/users/sign_in)原始 HTML 含真实登录表单。用“文章入口重定向到该响应”的构造重放，基线误收 371 字登录说明，候选返回 `null`；不声称实际观察到某篇 GNOME 文章发生该跳转。[WordPress 登录路径](https://wordpress.org/wp-login.php)由未识别变为识别，其实际最终跳转到另一域名根路径的正文前后均为 `null`。

候选在 UTC 和 America/Los_Angeles 下的 1423 条观察记录逐条一致，包含 1418 条 RSS/列表、1 次详情读取、2 个登录路径和 2 次正文重放。Hugging Face 超时，TNW、GitLab.com、WordPress.com 返回 403，均未计入有效样本。这些网站只作 HTTP 回归证据，不更改本项目信源选择。

## 本机证据位置

| 证据 | 本轮本机路径 |
| --- | --- |
| 类型、构建、Web 最终日志 | `/private/tmp/aihot-six-{typecheck,build,web-tests}.log` |
| 后端最终日志 | `/private/tmp/aihot-upstream-backend-final-r2-20261028.log` |
| standalone / smoke 与 MCP | `/private/tmp/aihot-upstream-{standalone,smoke-mcp}-final-20261028.log` |
| 冻结样本、校验哈希及重放脚本 | `/private/tmp/aihot-upstream-real-samples-20261028.iEIY83/` |
| 浏览器结果、12 张截图及临时脚本 | `/private/tmp/aihot-six-fixes-browser-20261028/` |

临时证据不是仓库随附文件。原始网页、登录页 token、响应 Cookie、业务数据或凭据均未提交；上面的行为、统计和逐项变更作为本次可审阅记录。
