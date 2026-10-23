# DEV-02：最小双频道数据库原型

这是 [多频道 ADR](../../docs/adr/0001-multi-space.md) 的可运行验证。它只证明精简关系模型中的频道边界，**没有改造现有 AIHOT 采集、模型、publication、报告或通知链路**，也不是生产迁移。

## 运行

需要 Node.js >= 24.22.1、仓库依赖，以及一个明确授权的本地 PostgreSQL 测试库。账号需能在该库创建 schema；原型不创建数据库、不启动数据库服务。

本次 DEV-01 准备了本地私有连接文件 `.data/dev-postgres/proof.env`（不提交 Git，权限 0600），其内容只为原型设置 `MULTI_SPACE_DATABASE_URL`。在仓库根目录运行：

```bash
node node_modules/typescript/bin/tsc -p experiments/multi-space
env -u MULTI_SPACE_DATABASE_URL node --env-file=.data/dev-postgres/proof.env --test experiments/multi-space/proof.test.ts
```

在其他开发环境，显式提供自己的 `MULTI_SPACE_DATABASE_URL` 即可。连接必须使用 `127.0.0.1` 或 `[::1]`、显式端口/用户名、以 `_test` 或 `_ci` 结尾的库名。拒绝 URL 查询参数和 fragment，避免连接参数覆盖。原型不读取 `.env`、`DATABASE_URL` 或应用凭据。

每个数据库用例在独立事务中创建随机 `dev02_*` schema、装入 `schema.sql` 和测试样本。成功时主动回滚，失败时由事务回滚；成功用例还查询 PostgreSQL 系统目录确认自己的 schema 已消失。不会执行 `DROP`、生产迁移或清理其他 schema。

## 实际验证范围

| 行为 | 验证方式 |
| --- | --- |
| 同 URL 的频道内去重与频道间独立 | 在真实 PostgreSQL 写入两频道；同频道重复入库返回同一 ID，跨频道分配不同全局 ID |
| 筛选互不影响 | 根据数据库里各频道不同的关键词规则处理同一标题；安全频道选中、硬件频道 BLOCK，重复请求复用同一结果 |
| 配置/输入版本与请求标识 | 上下文显式传 `spaceId/configVersion`；结果保存输入修订、规则版本、模型标识；更换规则/模型版本或输入修订产生新请求，并保留旧结果 |
| 数据库阻止跨频道关联 | 绕过业务函数直接写错频道的处理结果、配置、日报条目及通知引用，断言 PostgreSQL 返回外键错误 |
| 同日日报与推送目标隔离 | 两频道同日分别生成日报，从各自选中结果取内容，仅路由到各自本地 sink 标识；重放不重复建投递记录，频道内重复日报被唯一约束拒绝 |
| 未知频道不回退 | 未知频道/配置版本的入库、报告和投递请求显式失败；直接写未知频道同样被数据库拒绝 |

筛选器是读取频道配置的**本地确定性规则夹具**，`model_id` 为 `local-rule-fixture` 等测试标识，不调用 DeepSeek。通知只写 `pending` 记录和本地 sink 标签，不访问 Webhook、飞书或任何外网 URL。样本中的 `example.invalid` 仅作为字符串使用。

## 有意简化与 M2 后续工作

- `UNIQUE(space_id, canonical_url)` 只验证上游内容身份的 **URL 子集**。生产契约使用 `(space_id, identity_key)`，继续保留 URL/X/source fallback 规则，不能照抄本表替换现有身份算法。
- 表和函数是精简夹具；没有连接现有 source、analysis、story、publication、receipt、settings、cache、浏览器状态或身份权限。跨频道外键证明写入关系隔离，不等于数据库行级权限或所有读取路径已安全。
- M2 仍需接入频道配置、任务上下文、完整文章修订和模型回执/预算、归组、选中状态、报告周期/时区/调度、缓存以及所有公开出口，并验证旧单站数据迁移与旧 URL。
- 日报只验证单日期唯一性和内容关联；通知只验证路由和数据库去重，没有发送确认、`unknown`、重试恢复或 exactly-once 外部投递保证。
- 跨频道独立存记录不代表来源许可/撤回可以忽略。生产实现必须区分源级修订/撤回与频道级编辑，并测试应联动的失效范围。
- 安全模块的证据入口、资产匹配、权限、响应状态机、真实 DeepSeek 评测与 GKE 运行态仍按开发计划分别交付。

本目录有独立 TypeScript 检查配置；根目录 `npm test` / `npm run typecheck` 暂不包含此实验。GitHub Actions 的 `Multi-space design proof` 步骤会在本地临时 CI 数据库中单独执行类型检查和实验。运行结果必须单独记录，不能计为生产全链路已完成。
