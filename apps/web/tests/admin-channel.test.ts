import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const at = "2026-10-04T00:00:00.000Z";
const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; key?: string }> = [];
let securityEnabled = true;
let delayPreview = false;
let releasePreview: (() => void) | undefined;
let delayCreate = false;
let releaseCreate: (() => void) | undefined;
let failCreateOnce = false;
const spaces = () => [
  { id: "default", slug: "default", name: "AI", enabled: true, failedSources: 1 },
  { id: "security", slug: "cyber-security", name: "网络安全", enabled: securityEnabled, failedSources: 2 },
];
const source = (spaceId: string, id = `${spaceId}-source`) => ({
  id, space_id: spaceId, name: spaceId === "security" ? "安全测试源" : "AI 测试源", kind: "rss", tier: "T2", enabled: true,
  participation_mode: "editorial", interval_minutes: 60, first_party: false, signal_group_id: null, owner_entity_id: null,
  site_fulltext: false, syndicate_fulltext: false, tags: [], config: { feedUrl: "https://example.org/feed" },
  created_at: at, updated_at: at, next_fetch_at: null, last_fetch_at: null, last_ok_at: null, health: "ok", fail_count: 0,
});
const preview = { count: 1, ms: 1, items: [{ title: "旧频道迟到预览", url: "https://example.org/preview", publishedAt: at, publicationTime: "2026-10-04", excerpt: "fixture" }] };
const api = fakeApi(async (url, res, req) => {
  const path = url.pathname;
  let body: Record<string, unknown> | null = null;
  if (!["GET", "HEAD"].includes(req.method!)) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = raw ? JSON.parse(raw) : null;
  }
  requests.push({ path, method: req.method!, body, key: req.headers["idempotency-key"] as string | undefined });
  if (path === "/api/admin/me") return { name: "Fixture admin", csrf: "fixture", dev: true };
  if (path === "/api/admin/nav-counts") return { sources: 99, runs: 0, feedback: 0 };
  if (path === "/api/admin/spaces") return { spaces: spaces() };
  if (path === "/api/admin/settings") return { contact: { wechatQr: null, feishuQr: null }, targets: [], budgets: [] };
  if (path === "/api/admin/audit") return { page: 1, rows: [] };
  const match = /^\/api\/admin\/spaces\/([^/]+)\/sources(?:\/(.+))?$/.exec(path);
  if (match) {
    const spaceId = decodeURIComponent(match[1]!);
    if (!spaces().some((space) => space.id === spaceId)) { res.statusCode = 404; return { code: "not_found" }; }
    const tail = match[2];
    if (tail === "preview" || tail?.endsWith("/preview")) {
      if (delayPreview) return new Promise((resolve) => { releasePreview = () => resolve(preview); });
      return preview;
    }
    if (!tail && req.method === "POST") {
      if (failCreateOnce) { failCreateOnce = false; res.statusCode = 503; return { detail: "本地测试重试" }; }
      const created = { created: true, source: source(spaceId, String(body!.id)) };
      return delayCreate ? new Promise((resolve) => { releaseCreate = () => resolve(created); }) : created;
    }
    if (!tail) return { page: 1, rows: [{ ...source(spaceId), items_7d: 0, selected_30d: 0 }], totals: { total: 1, enabled: 1, failing: 0, degraded: 0 } };
    if (tail.endsWith("/fetch")) return { queued: true };
    if (tail !== `${spaceId}-source` && tail !== "created-source") { res.statusCode = 404; return { code: "not_found" }; }
    return { source: source(spaceId, tail), runs: [], items: [], stats: { total: 0, last7d: 0, selected: 0 }, history: [], republish: null };
  }
  if (path === "/api/admin/content/security-item") return {
    article: { id: "security-item", source_id: "security-source", space_id: "security", space_slug: "cyber-security", source_name: "安全测试源",
      source_kind: "rss", tier: "T2", participation_mode: "editorial", title: "安全诊断", url: "https://example.org/item", identity_key: "security-item",
      author: null, language: "en", published_at: at, publication_time: "2026-10-04", published_at_claim: at, discovered_at: at, timeline_at: at,
      backfill: true, body_status: "ok", revision: 1, processing_state: "analyzed", processing_error: null, grouped_at: null, body_chars: 100,
      site_fulltext: false, syndicate_fulltext: false },
    discoveries: [], revisions: [], analyses: [], publication: { visibility: "public", title: "安全诊断", tags: [] },
    override: null, ledger: [], membership: [], decisions: [], deliveries: [], history: [],
  };
});

let web: WebServer;
let browser: Browser;
before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => { releasePreview?.(); releaseCreate?.(); await browser?.close(); await web?.stop(); });

test("legacy source URLs redirect explicitly to AI and channel lists only request their own sources", async () => {
  for (const suffix of ["", "/new", "/default-source"]) {
    const response = await fetch(`${web.origin}/admin/sources${suffix}?q=keep`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/admin/channels/default/sources${suffix}?q=keep`);
  }
  requests.length = 0;
  for (const [id, title] of [["default", "AI 测试源"], ["security", "安全测试源"]]) {
    const response = await fetch(`${web.origin}/admin/channels/${id}/sources`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(title!));
    assert.ok(html.includes(`/admin/channels/${id}/sources/new`));
  }
  assert.ok(requests.some((request) => request.path === "/api/admin/spaces/security/sources"));
  assert.ok(!requests.some((request) => request.path.startsWith("/api/admin/sources")));
  const invalid = await fetch(`${web.origin}/admin/channels/unknown/sources`);
  assert.equal(invalid.status, 404);
});

for (const width of [390, 1366]) test(`the ${width}px management selector isolates channels and identifies platform scope`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/admin/channels/security/sources/security-source`);
    const selector = page.getByRole("combobox", { name: "管理范围", exact: true }).filter({ visible: true });
    await expect(selector).toHaveValue("security");
    await selector.selectOption("default");
    await expect(page).toHaveURL(`${web.origin}/admin/channels/default/sources`);
    await expect(page.getByRole("link", { name: "AI 测试源", exact: true })).toBeVisible();
    await selector.selectOption("");
    await expect(page).toHaveURL(`${web.origin}/admin/settings`);
  } finally { await context.close(); }
});

test("dirty source drafts stay in their channel until discarded, and old previews cannot populate the next channel", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/admin/channels/security/sources/new`);
    await page.getByPlaceholder("openai-blog").fill("new-security-source");
    const selector = page.getByRole("combobox", { name: "管理范围", exact: true }).filter({ visible: true });
    await selector.selectOption("default");
    await expect(page.getByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(selector).toHaveValue("security");
    delayPreview = true;
    await page.getByRole("button", { name: "预览抓取", exact: true }).click();
    await expect.poll(() => !!releasePreview).toBe(true);
    await selector.selectOption("default");
    await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/channels/default/sources`);
    releasePreview!();
    await expect(page.getByText("旧频道迟到预览", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "新建信源", exact: true }).click();
    await expect(page.getByPlaceholder("openai-blog")).toHaveValue("");
  } finally { delayPreview = false; releasePreview?.(); releasePreview = undefined; await context.close(); }
});

test("source creation captures its channel and a successful save can leave the dirty form", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/admin/channels/security/sources/new`);
    await page.getByPlaceholder("openai-blog").fill("created-source");
    await page.getByPlaceholder("OpenAI 博客").fill("新安全来源");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/channels/security/sources/created-source`);
    const created = requests.findLast((request) => request.method === "POST" && request.path.endsWith("/sources"));
    assert.equal(created!.path, "/api/admin/spaces/security/sources");
    assert.equal(created!.body!.id, "created-source");
    assert.ok(created!.key);
  } finally { await context.close(); }
});

test("a completed creation in the previous channel cannot navigate the new channel back", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/admin/channels/default/sources/new`);
    await page.getByPlaceholder("openai-blog").fill("created-source");
    await page.getByPlaceholder("OpenAI 博客").fill("迟到的 AI 来源");
    delayCreate = true;
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect.poll(() => !!releaseCreate).toBe(true);
    await page.getByRole("combobox", { name: "管理范围", exact: true }).filter({ visible: true }).selectOption("security");
    await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/channels/security/sources`);
    const response = page.waitForResponse((response) => response.url().endsWith("/api/admin/spaces/default/sources") && response.request().method() === "POST");
    releaseCreate!();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(`${web.origin}/admin/channels/security/sources`);
  } finally { delayCreate = false; releaseCreate?.(); releaseCreate = undefined; await context.close(); }
});

test("a retry reuses its key while another channel receives a distinct command identity", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    requests.length = 0;
    await visit(page, `${web.origin}/admin/channels/default/sources/new`);
    await page.getByPlaceholder("openai-blog").fill("created-source");
    await page.getByPlaceholder("OpenAI 博客").fill("同名测试来源");
    failCreateOnce = true;
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("本地测试重试");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/channels/default/sources/created-source`);
    const retried = requests.filter((request) => request.method === "POST" && request.path === "/api/admin/spaces/default/sources");
    assert.equal(retried.length, 2);
    assert.equal(retried[0]!.key, retried[1]!.key);
    await visit(page, `${web.origin}/admin/channels/security/sources/new`);
    await page.getByPlaceholder("openai-blog").fill("created-source");
    await page.getByPlaceholder("OpenAI 博客").fill("同名测试来源");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page).toHaveURL(`${web.origin}/admin/channels/security/sources/created-source`);
    const other = requests.findLast((request) => request.method === "POST" && request.path === "/api/admin/spaces/security/sources");
    assert.notEqual(other!.key, retried[0]!.key);
  } finally { failCreateOnce = false; await context.close(); }
});

test("disabled channels remain configurable and diagnostics link to the object's real channel and public slug", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    securityEnabled = false;
    await visit(page, `${web.origin}/admin/channels/security/sources/security-source`);
    await expect(page.getByRole("button", { name: "预览当前配置", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "立即采集", exact: true })).toBeDisabled();
    await visit(page, `${web.origin}/admin/content/security-item`);
    await expect(page.getByRole("link", { name: "安全测试源", exact: true }).first()).toHaveAttribute("href", "/admin/channels/security/sources/security-source");
    await expect(page.getByRole("link", { name: "公开页", exact: true })).toHaveAttribute("href", "/channels/cyber-security/items/security-item");
  } finally { securityEnabled = true; await context.close(); }
});
