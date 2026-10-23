# 本项目开发与提交

本仓库按[独立维护约定](docs/fork-maintenance.md)开发，当前仓库为 [zhangxudongsteven/AIHOT](https://github.com/zhangxudongsteven/AIHOT)。后续需求、修复和评审在这里进行，不再以向原项目贡献为目标。

## 工作范围

从当前项目基线创建工作分支，围绕明确问题组织改动。已有缺陷先查看 [MS-001～MS-007](docs/known-issues.md)；新需求结合[开发计划](docs/development-plan.md)记录范围和验收条件。Issue/PR 使用当前仓库可用的入口，安全问题按 [SECURITY.md](SECURITY.md) 联系本项目维护者。

项目专用功能可以在此实现，不要求为了上游通用性增加配置或抽象。优先复用已有能力，并按职责将独立业务放入 `modules/`；站点配置在 `site/`，示范行业知识在 `industry/`。正式名称、信源、分类、门槛和条款仍由使用者确定。

## 实现与验证

1. 阅读 [AGENTS.md](AGENTS.md) 和任务对应文档。保留前后端边界、统一公开读取层、付费回执与预算机制。原规则中“提回 KKKKhazix/AIHOT”的要求只适用于该上游贡献场景，本项目正常开发不受其收稿范围限制。
2. 保持改动可审阅，不夹带无关依赖更新或格式重写。依赖、规则和二进制如确有修改需要，说明原因与验证方式，不沿用上游“不接收外部 PR”的限制作为本项目禁令。
3. 使用独立测试库和本地假服务，开发外发开关保持关闭。代码改动完成 `npm run typecheck`、`npm test`、Web 构建和 Web 测试，站点启动后执行 smoke；命令与测试库要求见[本地开发说明](docs/local-development.md)。纯文档改动检查链接、格式及实际展示。
4. 历史数据库迁移不改，新迁移使用新文件名并遵守[在线迁移约定](docs/architecture.md#数据库迁移)。记录升级及回退影响，不能用镜像回滚代替数据回滚。
5. 提交说明写清问题、结果、验证和已知限制。修复已知问题时记录问题编号、修复提交和回归结果后再关闭；文档登记不算修复。

## 更新日志与上游补丁

开发者变化进入 [CHANGELOG.md](CHANGELOG.md) 的“未发布”；读者可见的更新同步到 [site/changelog.json](site/changelog.json)。涉及公开协议、配置或数据库升级时，同步版本和[部署说明](docs/deploy.md)，版本规则见[独立维护约定](docs/fork-maintenance.md)。

选择性引入上游补丁时保留来源提交和署名，说明本项目适配及测试结果。没有默认同步、向上游提 PR、强制整理成单提交或改写已推送历史的流程。

不提交 `.env`、密钥、Cookie、生产数据或 `.data/` 本机证据。保留 [MIT 许可证](LICENSE) 与 [NOTICE](NOTICE) 中的版权和第三方声明。
