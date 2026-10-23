# Multi-channel development fork

This is an independently maintained fork of [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT), maintained in [zhangxudongsteven/AIHOT](https://github.com/zhangxudongsteven/AIHOT). Future requirements, fixes, versions, and changelogs belong to this project. Contributing changes back to the original project is no longer the development target.

The application collects sources, selects and writes content, groups events, and creates daily, weekly, and monthly reports for separate business channels. One website exposes these channels through web pages, RSS, a public API, Agent Markdown, and MCP. Security intelligence comes first; overseas policy and consumer hardware are planned later. The final name, branding, sources, and business rules are still pending; `MyHOT` remains a placeholder.

[简体中文](README.md) · [Changelog](CHANGELOG.md) · [Maintenance policy](docs/fork-maintenance.md) · [Known issues](docs/known-issues.md)

## Current state

The first independently maintained development baseline is **4.1.0** at commit `b0ea3ed`, based on upstream commit `b3998dc6fc138eb9659f33f55eb38c1c716f0d57`. This is this project's version, not an upstream release.

- DEV-01 through DEV-05 implement versioned channel configuration, scoped collection and processing, website navigation and public endpoints, independent reports, notification subscriptions, and request quotas.
- Handoff checks passed: 1033/1033 backend tests, 66/66 Web tests, type checking, and the Web build. See the [handoff validation](docs/reports/2026-10-23-new-machine-handoff.md) for scope and initial failed runs. A new machine still requires validation; earlier results are in the [review record](docs/reports/2026-10-23-review.md) and [LAN validation record](docs/reports/2026-10-23-lan-deployment.md).
- [Seven confirmed issues](docs/known-issues.md) remain open for a later version. Passing tests does not close them.
- One real DeepSeek request through TokenHub, receipt reuse, and quota enforcement have been verified; see the [integration record](docs/reports/2026-10-23-deepseek-integration.md). The full content pipeline and Feishu delivery remain unverified, and persistent external-action flags remain disabled.
- The short-term target is a MacBook Pro with native PostgreSQL 17 and application-only Compose. The [deployment template](docs/macbook-deployment.md) is ready, but the target machine has not been deployed. Security evidence, asset-response workflows, business acceptance, and GKE deployment remain pending.

## Local development

Use Node.js 24, PostgreSQL 17, and npm workspaces. Follow the [local development guide](docs/local-development.md) for database setup, private connection files, and process startup. Keep real collection, model calls, Feishu delivery, and IndexNow submission disabled during development.

```bash
git clone --branch main https://github.com/zhangxudongsteven/AIHOT.git
cd AIHOT
npm ci
```

Use this repository's `main` as the development and deployment baseline. Create branches from `main` for further development and merge through pull requests. Follow the [new-machine guide](docs/new-machine-setup.md) for setup. Git contains code, templates, and documentation; databases, file volumes, and credentials require separate preparation. Verify the remote branch and commit with `git ls-remote` or `git fetch`.

See the [customization guide](docs/customize.md), [channel guide](docs/multi-space-development.md), and [deployment guide](docs/deploy.md) for configuration and upgrade requirements. Example industry data and sources are not approved production configuration.

```bash
npm run typecheck
npm run build -w @aihot/web
# Use an isolated *_test or *_ci database and local fake providers.
DATABASE_URL=postgres://127.0.0.1:5432/company_test npm test
node --test apps/web/tests/*.test.ts
# After starting the local site:
node scripts/smoke.ts --base http://127.0.0.1:3000
```

## Documentation

The detailed documents are in Chinese.

| Document | Purpose |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | This project's development releases and unreleased changes |
| [site/changelog.json](site/changelog.json) | Updates displayed to this site's readers |
| [Maintenance policy](docs/fork-maintenance.md) | Independent versioning, upstream references, and release records |
| [Development plan](docs/development-plan.md) | Scope, milestones, and pending business inputs |
| [New-machine setup](docs/new-machine-setup.md) | Fetching the main baseline, isolating data, restoring private configuration, and validation |
| [Known issues](docs/known-issues.md) | Reproduction, impact, and acceptance criteria for MS-001 through MS-007 |
| [Channel guide](docs/multi-space-development.md) | Configuration, processing, public endpoints, reports, notifications, and quotas |
| [Architecture](docs/architecture.md) | Web/API/worker, modules, migrations, and the public read layer |
| [Sources](docs/sources.md) | Source types, dates, full-text permissions, and external ingestion |
| [Selection](docs/selection.md) | Scoring and sample-based threshold calibration |
| [Grouping](docs/grouping.md) | Event relationships and evaluation |
| [Overview evaluation](docs/story-digest-evaluation.md) | Comparing event overviews on fixed samples |

## Maintenance and attribution

Review and submit changes in the [current repository](https://github.com/zhangxudongsteven/AIHOT), following [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues to this project's maintainer as described in [SECURITY.md](SECURITY.md).

The `upstream` remote is retained for provenance and optional patches. Importing an upstream change requires this project's review and validation; upstream releases are not automatically adopted.

Thanks to the original author 数字生命卡兹克 and upstream contributors. The original [MIT license and copyright notice](LICENSE) and [third-party notices](NOTICE) are retained. The upstream name and logo are not this project's branding. Pre-fork source and documentation remain in Git history.
