# Multi-channel development fork

This is an independently maintained fork of [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT), maintained in [zhangxudongsteven/AIHOT](https://github.com/zhangxudongsteven/AIHOT). Future requirements, fixes, versions, and changelogs belong to this project. Contributing changes back to the original project is no longer the development target.

The application collects sources, selects and writes content, groups events, and creates daily, weekly, and monthly reports for separate business channels. One website exposes these channels through web pages, RSS, a public API, Agent Markdown, and MCP. AI and security are in progress; overseas policy and consumer hardware are planned later. The final name, branding, and complete source and business rules are still pending; `MyHOT` remains a placeholder.

[简体中文](README.md) · [Changelog](CHANGELOG.md) · [Maintenance policy](docs/fork-maintenance.md) · [Known issues](docs/known-issues.md)

## Current state

The current project version is **4.2.0**; the public protocol remains **4.1.0**. Tag `v4.2.0` records the source release, not a production deployment.

The first independently maintained development baseline is **4.1.0** at commit `b0ea3ed`, forked from upstream commit `b3998dc6fc138eb9659f33f55eb38c1c716f0d57`. Later upstream fixes are imported individually. This is this project's version, not an upstream release.

- DEV-01 through DEV-05 implement versioned channel configuration, scoped collection and processing, website navigation and public endpoints, independent reports, notification subscriptions, and request quotas.
- As of October 28, 2026, `main` includes channel administration, source date precision and security advisory collection, and [six upstream date and sign-in fixes](docs/reports/2026-10-28-upstream-six-fixes.md). The six-fix baseline passed 1095/1095 backend tests, 99/99 Web tests, type checking, build, smoke, and MCP checks on Node 24. Those results apply to the fixed version in that report; subsequent changes need their own validation. Earlier 4.2.0 results are in the [development record](docs/reports/2026-10-27-ai-security-channels.md).
- MS-001, MS-003, MS-005, and MS-006 are fixed in 4.2.0 (implementation commit `e341acb`); MS-002, MS-004, and MS-007 remain [open](docs/known-issues.md).
- [Candidate channel exports](docs/ai-security-channels.md) remain disabled by default. On October 28, selected AI news, arXiv abstract, and Node.js/Spring security sources were enabled in `myhot-lan` with user authorization; see the [operations summary](docs/reports/2026-10-28-operations-summary.md). Pulling source code does not replay those runtime actions or database state. Security thresholds remain uncalibrated.
- Small samples have exercised real collection, body/date extraction, model prefiltering, and dual scoring. Paper trials still require observation of pagination, duplicate versions, asynchronous processing, and output quality. AI content subscriptions remained disabled during these operations; this does not establish delivery settings for other channels. Development continues to disable real collection, model calls, and external actions; staging keeps isolated data and external actions disabled.
- [LAN operation](docs/lan-deployment.md) and [isolated staging acceptance](docs/reports/2026-10-28-source-dates-staging.md) have been recorded. The [MacBook Pro native PostgreSQL template](docs/macbook-deployment.md) is an alternative deployment method requiring separate acceptance on its target machine. Security evidence, asset-response workflows, sustained operational acceptance, and GKE deployment remain pending.

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
| [October 28 operations summary](docs/reports/2026-10-28-operations-summary.md) | AI, security, and paper source operations, public validation summaries, and pending acceptance |
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
