import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSpaceConfig, type SpaceConfig } from "../../../packages/backend/src/spaces/config.ts";

// Candidate editorial rules, not a calibrated or activated production configuration.
const categories = [
  { key: "vulnerability", label: "漏洞与补丁", section: "漏洞与补丁", tagColor: "red", guide: "具体漏洞的披露、影响版本、补丁、缓解措施和利用状态更新。以修复或受影响条件为重点；真实攻击和事故调查归攻击与事件。" },
  { key: "incident", label: "攻击与事件", section: "攻击与事件", tagColor: "orange", guide: "实际攻击、入侵、泄露、勒索及其调查和处置进展。区分当事方确认、研究者观察和未经证实的主张；不把公开漏洞自动当成事故。" },
  { key: "research", label: "威胁研究", section: "威胁研究", tagColor: "violet", guide: "新的攻击方法、漏洞成因、威胁行为、检测实验和研究数据。研究性的概念验证不是已发生攻击；以方法和发现为核心。" },
  { key: "practice", label: "防护实践", section: "防护实践", tagColor: "green", guide: "可复用的安全配置、检测、排查、响应、修复及工程复盘。具体漏洞公告中的处置说明仍归漏洞与补丁，发布工具仍归工具产品。", commentary: true },
  { key: "tools", label: "工具产品", section: "工具产品", tagColor: "turquoise", guide: "安全工具、平台、开源组件和重要功能的实际发布。具体说明能力与适用条件；不因厂商品牌归成攻击事件。" },
  { key: "industry", label: "政策行业", section: "政策与行业", tagColor: "indigo", guide: "安全政策、监管、标准、司法和行业经营变化，以及以判断为核心的评论。单纯广告、活动和招聘没有独立新闻价值。" },
];

const categoryTags = ["漏洞披露", "补丁更新", "攻击事件", "威胁研究", "防护实践", "工具发布", "政策/监管", "行业动态", "观点分析", "其他"];
const topicTags = ["云与 Kubernetes", "身份与访问", "应用与 API", "软件供应链", "终端与勒索", "网络边界", "数据保护", "AI 安全"];
const entities = {
  google: { name: "Google Cloud", displayTag: "Google Cloud", aliases: ["Google Cloud", "GCP", "Google", "谷歌云"], orgNames: ["Google Cloud", "Google", "谷歌"] },
  microsoft: { name: "Microsoft", displayTag: "Microsoft", aliases: ["Microsoft", "微软", "MSRC"], orgNames: ["Microsoft", "微软", "Microsoft Security Response Center"] },
  kubernetes: { name: "Kubernetes", displayTag: "Kubernetes", aliases: ["Kubernetes", "K8s"], orgNames: ["Kubernetes"] },
  github: { name: "GitHub", displayTag: "GitHub", aliases: ["GitHub"], orgNames: ["GitHub"] },
  cloudflare: { name: "Cloudflare", displayTag: "Cloudflare", aliases: ["Cloudflare"], orgNames: ["Cloudflare"] },
  cisa: { name: "CISA", displayTag: "CISA", aliases: ["CISA", "Cybersecurity and Infrastructure Security Agency"], orgNames: ["CISA"] },
  aws: { name: "AWS", displayTag: "AWS", aliases: ["AWS", "Amazon Web Services", "亚马逊云科技"], orgNames: ["AWS", "Amazon Web Services"] },
  redhat: { name: "Red Hat", displayTag: "Red Hat", aliases: ["Red Hat", "红帽"], orgNames: ["Red Hat"] },
  apache: { name: "Apache", displayTag: "Apache", aliases: ["Apache Software Foundation", "Apache"], orgNames: ["Apache Software Foundation"] },
  linux: { name: "Linux", displayTag: "Linux", aliases: ["Linux", "Linux Kernel"], orgNames: ["Linux Foundation"] },
  openssl: { name: "OpenSSL", displayTag: "OpenSSL", aliases: ["OpenSSL"], orgNames: ["OpenSSL"] },
};

const pattern = (source: string) => ({ source, flags: "i" });

/** Retain model routing and numeric thresholds until they have been evaluated on labelled samples. */
export function securitySpaceConfig(base: SpaceConfig): SpaceConfig {
  const directory = path.join(import.meta.dirname, "prompts");
  const overrides = Object.fromEntries(readdirSync(directory).filter(name => name.endsWith(".md")).map(name => [name.slice(0, -3), readFileSync(path.join(directory, name), "utf8")]));
  return parseSpaceConfig({
    ...structuredClone(base),
    siteName: "网络安全",
    reasonLabel: "阅读价值",
    reports: {
      editionTimes: { daily: "08:00", weekly: "08:00", monthly: "08:00" },
      quiet: { title: "本期暂无入选安全动态", paragraph: "本期没有达到当前筛选门槛的条目；这不代表没有安全风险。" },
      plainTerms: ["api", "cve", "ghsa", "cvss", "cwe", "ioc", "sbom", "sso", "mfa", "oauth", "jwt", "tls", "dns", "rce", "ai"],
      release: null,
    },
    prompts: { ...base.prompts, ...overrides },
    categories, categoryTags, topicTags,
    entityTags: Object.values(entities).map(entity => entity.displayTag),
    entities, entityOrder: Object.keys(entities),
    tagSynonyms: {
      漏洞: "漏洞披露", CVE: "漏洞披露", 补丁: "补丁更新", 修复: "补丁更新", 入侵: "攻击事件", 泄露: "攻击事件",
      安全研究: "威胁研究", 检测: "防护实践", 安全扫描: "防护实践", devops: "防护实践", DevSecOps: "防护实践",
      开源: "工具发布", 工具: "工具发布", 政策: "政策/监管", 监管: "政策/监管", 观点: "观点分析",
      云安全: "云与 Kubernetes", K8s: "Kubernetes", IAM: "身份与访问", API: "应用与 API",
      供应链: "软件供应链", 勒索软件: "终端与勒索", 网络安全: "网络边界", 数据安全: "数据保护", 大模型安全: "AI 安全",
    },
    itemTypes: ["vulnerability_notice", "product_launch", "defensive_method", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"],
    identityLexicon: [
      { id: "google", name: "Google", patterns: [pattern("\\bGoogle(?:\\s+Cloud)?\\b|谷歌(?:云)?")] },
      { id: "microsoft", name: "Microsoft", patterns: [pattern("\\bMicrosoft\\b|\\bMSRC\\b|微软")] },
      { id: "kubernetes", name: "Kubernetes", patterns: [pattern("\\bKubernetes\\b|\\bK8s\\b")] },
      ...["github", "cloudflare", "cisa", "aws", "apache", "linux", "openssl"].map(id => ({ id, name: entities[id as keyof typeof entities].name, patterns: [pattern(`\\b${id}\\b`)] })),
      { id: "redhat", name: "Red Hat", patterns: [pattern("\\bRed\\s+Hat\\b|红帽")] },
    ],
    publisherDomains: [
      { entityId: "google", domains: ["cloud.google.com", "docs.cloud.google.com", "security.googleblog.com"] },
      { entityId: "microsoft", domains: ["microsoft.com", "msrc.microsoft.com", "api.msrc.microsoft.com"] },
      { entityId: "kubernetes", domains: ["kubernetes.io"] }, { entityId: "github", domains: ["github.blog", "github.com"] },
      { entityId: "cloudflare", domains: ["cloudflare.com"] }, { entityId: "cisa", domains: ["cisa.gov"] },
      { entityId: "aws", domains: ["aws.amazon.com"] }, { entityId: "redhat", domains: ["redhat.com"] },
      { entityId: "apache", domains: ["apache.org"] }, { entityId: "linux", domains: ["kernel.org", "linuxfoundation.org"] },
      { entityId: "openssl", domains: ["openssl.org"] },
    ],
    identityContextAliases: [],
    readerWording: [],
  });
}
