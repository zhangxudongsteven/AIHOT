// Offline candidate export: no database, credential-file loading, fetching, model calls or activation.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultSpaceConfig, parseSpaceConfig, spaceConfigVersion, type SpaceConfig } from "../packages/backend/src/spaces/config.ts";
import { REPO_ROOT } from "../packages/backend/src/config.ts";
import { securitySpaceConfig } from "../industry/channels/security/config.ts";

const usage = "prepare-channel-configs.ts [--out <new-directory>] | --validate <directory>";
type CandidateSources = { sources: Array<Record<string, unknown> & { id: string; enabled: false }> };
const configFiles = { default: "ai.config.json", security: "security.config.json" };
const sourceFiles = { default: "ai.sources.json", security: "security.sources.json" };

async function sourcesFrom(file: string): Promise<CandidateSources> {
  const { sources } = JSON.parse(await readFile(file, "utf8")) as { sources: Array<Record<string, unknown> & { id: string }> };
  return { sources: sources.map(source => ({ ...source, enabled: false })) };
}

function checkSources(candidates: CandidateSources, config: SpaceConfig): void {
  // Full source intake validation is performed by space-sources.ts plan against the selected space.
  const ids = new Set<string>();
  for (const source of candidates.sources) {
    if (!source.id || ids.has(source.id) || source.enabled !== false) throw new Error("Invalid candidate source state");
    ids.add(source.id);
    if (source.owner_entity_id && !Object.hasOwn(config.entities, String(source.owner_entity_id))) throw new Error("Unknown candidate source owner");
  }
}

async function validate(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.status !== "candidate" || manifest.applied !== false || manifest.calibration?.security !== "pending-human-labels") throw new Error("Invalid candidate manifest");
  const versions: Record<string, string> = {};
  for (const id of ["default", "security"] as const) {
    const config = parseSpaceConfig(JSON.parse(await readFile(path.join(directory, configFiles[id]), "utf8")));
    const version = spaceConfigVersion(config);
    if (version !== manifest.channels[id]?.configVersion) throw new Error("Configuration integrity mismatch");
    const sources = JSON.parse(await readFile(path.join(directory, sourceFiles[id]), "utf8")) as CandidateSources;
    checkSources(sources, config);
    if (sources.sources.length !== manifest.channels[id]?.candidateSources) throw new Error("Candidate source count mismatch");
    versions[id] = version;
  }
  return versions;
}

async function main() {
  const { values, positionals } = parseArgs({ options: { out: { type: "string" }, validate: { type: "string" } } });
  if (positionals.length || values.out && values.validate) throw new Error(usage);
  if (values.validate) {
    const directory = path.resolve(values.validate);
    console.log(JSON.stringify({ action: "validate", directory, versions: await validate(directory) }));
    return;
  }
  const ai = defaultSpaceConfig();
  const security = securitySpaceConfig(ai);
  const configs = { default: ai, security };
  const sources = {
    default: await sourcesFrom(path.join(REPO_ROOT, "industry/sources.json")),
    security: await sourcesFrom(path.join(REPO_ROOT, "industry/channels/security/sources.json")),
  };
  for (const id of ["default", "security"] as const) checkSources(sources[id], configs[id]);
  const preparedAt = new Date().toISOString();
  const directory = path.resolve(values.out ?? path.join(REPO_ROOT, ".data/channel-configs", `candidates-${preparedAt.replace(/[:.]/g, "-")}`));
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const write = (file: string, value: unknown) => writeFile(path.join(directory, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const channels = Object.fromEntries((["default", "security"] as const).map(id => [id, {
    configFile: configFiles[id], sourcesFile: sourceFiles[id], configVersion: spaceConfigVersion(configs[id]), candidateSources: sources[id].sources.length,
  }]));
  const manifest = {
    status: "candidate", applied: false, preparedAt,
    channels,
    calibration: { default: "unchanged-code-defaults-not-live-export", security: "pending-human-labels", humanGoldProvided: false, metricsComputed: false, thresholds: security.selection },
    notes: [
      "AI 配置来自仓库默认值及当前进程的模型配置环境变量，不是线上活动版本或数据库信源的导出。",
      "安全频道为技术负责人候选方案，分类、信源、模型和产出质量仍需业务验收。",
      "保留现有五轴权重和数字门槛不代表安全频道已校准；需准备人工标注样本并分别评测。",
      "全部候选信源 enabled=false，未导入数据库、未启用频道、未采集、未调用模型、未配置推送。",
      "仅保存模型名称、能力路由和凭证环境变量引用；不会读取 .env 或私有凭证文件。",
      "安全日报 08:00 按项目北京时间口径编排；AI 出刊时间保持仓库默认。",
      "信源导入前运行 space-sources.ts plan 对指定频道做完整schema、归属和重复校验；apply只新增，保留已有ID。",
      "6 个安全订阅先前通过端点与XML解析验证，尚未完成项目采集器及业务内容验收；MSRC需按实际产品复核筛噪，Kubernetes Blog不是完整漏洞覆盖，oss-security为公开邮件列表镜像。",
      "普通资讯采集、精选和日报不承担确定性紧急告警、公司资产影响核验或处置闭环。",
    ],
  };
  for (const id of ["default", "security"] as const) {
    await write(configFiles[id], configs[id]);
    await write(sourceFiles[id], sources[id]);
  }
  await write("manifest.json", manifest);
  console.log(JSON.stringify({ action: "prepare", directory, channels, status: "candidate", applied: false }));
}

try { await main(); }
catch {
  // Parser errors can contain supplied values. Do not echo inherited environment or raw snapshots.
  console.error(`${usage}\nChannel candidate command failed. Use a new output directory and valid configurations.`);
  process.exitCode = 1;
}
