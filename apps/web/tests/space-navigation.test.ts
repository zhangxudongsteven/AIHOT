import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect, type Browser } from "@playwright/test";
import type { ReportDetail } from "@aihot/contracts/site";
import { SITE, subjectAfter } from "@aihot/site";
import { fakeApi, feedItem, itemDetail, startWebServer, visit, FIXTURE_AT as at, type WebServer } from "./web-server.ts";

const spaces = [
  { id: "default", slug: "default", name: "默认频道", configVersion: "v1" },
  { id: "security", slug: "security", name: "安全测试频道", configVersion: "v1" },
  { id: "hardware", slug: "hardware", name: "硬件测试频道", configVersion: "v1" },
];
const reportKeys = ["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01"];
const reportHeadline = (name: string, key: string) => `${name}日报要闻 ${key}`;
const reportIndex = (name: string) => reportKeys.map((key, index) => ({ key, issueNumber: reportKeys.length - index, title: reportHeadline(name, key), count: 1 }));
function dailyReport(name: string, key: string): ReportDetail {
  const index = reportKeys.indexOf(key);
  return { kind: "daily", key, issueNumber: reportKeys.length - index, title: `${name} 日报 · ${key}`, generatedAt: at,
    lead: { title: reportHeadline(name, key), leadParagraph: `${name}独立日报摘要 ${key}` }, leadItemId: null,
    overview: null, highlights: [], sections: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1,
    prev: reportKeys[index + 1] ?? null, next: reportKeys[index - 1] ?? null };
}
const editionWhen = (slug: string) => slug === "security" ? "每天 09:15" : slug === "hardware" ? "每天 16:40" : "每天 08:00";
const requests: string[] = [];
let web: WebServer;
let browser: Browser;
const api = fakeApi((url, res) => {
  requests.push(url.pathname + url.search);
  const match = /^\/api\/site\/spaces\/([^/]+)(\/.*)$/.exec(url.pathname);
  const slug = match?.[1] ?? "default";
  const p = match ? `/api/site${match[2]}` : url.pathname;
  const space = spaces.find(s => s.slug === slug);
  if (!space) { res.statusCode = 404; return { code: "not_found" }; }
  const title = `${space.name}文章`;
  const item = feedItem({ id: "shared-item", title, category: null });
  if (p === "/api/site/meta") return { changelogVersion: null, space: match ? space : null, spaces, reportSettings: { editionWhen: { daily: editionWhen(slug), weekly: "每周一 10:00", monthly: "每月 1 日 10:30" }, releaseUnit: null }, categories: [{ key: "fixture", label: `${space.name}分类`, section: "内容", tagColor: "" }] };
  if (p === "/api/site/timeline") return { filters: { channel: "all", category: url.searchParams.get("category"), tag: null }, cards: [{ key: item.id, anchorAt: at, item, group: null }], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } };
  if (p === "/api/site/items/shared-item") return itemDetail({ id: item.id, title, category: null, body: { zh: `<p>${space.name}正文</p>`, original: null, zhKind: "translation", complete: true } });
  if (p === "/api/site/items/availability") return { items: [{ id: "shared-item", available: true }] };
  if (p === "/api/site/pool") return { filters: { channel: "all", category: null, tag: null, q: url.searchParams.get("q"), tab: "time" }, items: [item], page: 1, pageCount: 2, total: 2, todayCount: 1, freshness: at };
  if (p === "/api/site/hot") return { computedAt: at, windowHours: 48, entries: [] };
  if (p === "/api/site/topics") return { groups: [], topics: [] };
  if (p === "/api/site/search/suggestions") return { topics: [], hot: [] };
  if (p === "/api/site/reports/daily") return { kind: "daily", items: reportIndex(space.name) };
  if (p === "/api/site/reports/daily/latest-page") return { index: reportIndex(space.name), report: dailyReport(space.name, reportKeys[0]!) };
  if (/^\/api\/site\/reports\/daily\/(?:navigation|months)\//.test(p)) return { items: reportIndex(space.name) };
  const reportKey = /^\/api\/site\/reports\/daily\/(.+)$/.exec(p)?.[1];
  if (reportKey && reportKeys.includes(reportKey)) return dailyReport(space.name, reportKey);
  if (p.startsWith("/api/site/reports/")) { res.statusCode = 404; return { code: "not_found" }; }
  if (url.pathname.startsWith("/channels/") && /(?:feed\.xml|llms\.txt|openapi-v1\.json|\/og\/)/.test(url.pathname)) return { channel: url.pathname.split("/")[2] };
});

before(async () => {
  await mkdir(".data/dev-setup/dev04-screens", { recursive: true });
  await mkdir(".data/dev-setup/dev05-screens", { recursive: true });
  const started = await Promise.allSettled([startWebServer(api).then(value => { web = value; }), chromium.launch({ channel: "chromium" }).then(value => { browser = value; })]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});
after(async () => { await browser?.close(); await web?.stop(); });

test("desktop switches channels at their home and keeps links, filters, search and canonical URLs scoped", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await visit(page, web.origin + "/");
    await expect(page.getByRole("link", { name: "默认频道文章", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: subjectAfter("全部", "动态"), exact: true })).toBeVisible();
    await expect(page).toHaveTitle(SITE.homeTitle);
    await page.getByRole("combobox", { name: "切换频道" }).filter({ visible: true }).selectOption("security");
    await expect(page).toHaveURL(web.origin + "/channels/security");
    await expect(page.getByRole("link", { name: "安全测试频道文章", exact: true })).toHaveAttribute("href", "/channels/security/items/shared-item");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", web.origin + "/channels/security");
    await expect(page.locator('link[type="application/rss+xml"]')).toHaveAttribute("href", "/channels/security/feed.xml");
    await expect(page).toHaveTitle(`安全测试频道 · ${SITE.name}`);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "安全测试频道");
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", "安全测试频道的公开动态、精选与热点，附摘要和原文链接。");
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "全部动态", exact: true })).toBeVisible();
    const structured = await page.locator('script[type="application/ld+json"]').allTextContents();
    const dataset = structured.flatMap(value => JSON.parse(value)).find(value => value["@type"] === "Dataset");
    assert.equal(dataset.url, web.origin + "/channels/security");
    assert.equal(dataset.name, "安全测试频道");
    assert.ok(dataset.distribution.some((value: { contentUrl: string }) => value.contentUrl === web.origin + "/channels/security/feed/daily.xml"));
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "日报", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "安全测试频道分类", exact: true }).click();
    await expect(page).toHaveURL(web.origin + "/channels/security?category=fixture");
    await page.getByRole("textbox", { name: "搜索标题、摘要与正文" }).fill("漏洞");
    await page.getByRole("textbox", { name: "搜索标题、摘要与正文" }).press("Enter");
    await expect(page).toHaveURL(/\/channels\/security\/all\?/);
    await expect(page.getByRole("link", { name: "安全测试频道文章", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "安全测试频道文章", exact: true }).click();
    await expect(page.getByText("安全测试频道正文", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "切换频道" }).filter({ visible: true }).selectOption("hardware");
    await expect(page).toHaveURL(web.origin + "/channels/hardware");
    await expect(page.getByRole("link", { name: "硬件测试频道文章", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByText("安全测试频道正文", { exact: true })).toBeVisible();
    assert.ok(requests.some(path => path.startsWith("/api/site/spaces/security/pool?")));
    await mkdir(".data/dev-setup/dev04-screens", { recursive: true });
    await page.screenshot({ path: ".data/dev-setup/dev04-screens/channel-desktop.png", fullPage: true });
    for (const [path, heading, title] of [["all", "全部动态", "全部动态"], ["hot", "热点榜", "热点榜"], ["topics", "按主题浏览", "安全测试频道主题"]]) {
      await visit(page, `${web.origin}/channels/security/${path}`);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
      await expect(page.locator('meta[name="description"]')).not.toHaveAttribute("content", /AI/);
      await expect(page.locator('meta[property="og:description"]')).not.toHaveAttribute("content", /AI/);
      await page.screenshot({ path: `.data/dev-setup/dev04-screens/channel-desktop-${path}.png`, fullPage: true });
    }
    await visit(page, web.origin + "/channels/default");
    await expect(page).toHaveTitle(SITE.homeTitle);
  } finally { await context.close(); }
});

test("phone navigation, bookmarks, drafts and Agent addresses belong to the chosen channel", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, "share", { configurable: true, value: async (data: ShareData) => { (window as unknown as { sharedUrl: string }).sharedUrl = data.url ?? ""; } }));
  try {
    await visit(page, web.origin + "/channels/security");
    await expect(page.getByRole("navigation", { name: "底部导航" }).getByRole("link")).toHaveCount(4);
    await page.screenshot({ path: ".data/dev-setup/dev04-screens/channel-mobile-home.png", fullPage: true });
    await page.getByRole("link", { name: "安全测试频道文章", exact: true }).click();
    await expect(page.getByText("安全测试频道正文", { exact: true })).toBeVisible();
    const star = page.getByRole("button", { name: "收藏", exact: true });
    await star.click();
    await page.getByRole("button", { name: "分享", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { sharedUrl: string }).sharedUrl)).toBe(web.origin + "/channels/security/items/shared-item");
    await page.getByRole("combobox", { name: "切换频道" }).filter({ visible: true }).selectOption("hardware");
    await expect(page.getByRole("link", { name: "硬件测试频道文章", exact: true })).toBeVisible();
    await visit(page, web.origin + "/channels/hardware/starred");
    await expect(page.getByRole("link", { name: "安全测试频道文章", exact: true })).toHaveCount(0);
    await visit(page, web.origin + "/channels/security/starred");
    await expect(page.getByRole("link", { name: "安全测试频道文章", exact: true })).toBeVisible();
    await visit(page, web.origin + "/channels/security/feedback");
    await page.getByRole("textbox", { name: "想说点什么？" }).fill("security-only feedback draft");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("aihot:space:security:aihot-feedback-draft-v1"))).toContain("security-only feedback draft");
    await visit(page, web.origin + "/channels/hardware/feedback");
    await expect(page.getByRole("textbox", { name: "想说点什么？" })).toHaveValue("");
    await visit(page, web.origin + "/channels/security/feedback");
    await expect(page.getByRole("textbox", { name: "想说点什么？" })).toHaveValue("security-only feedback draft");
    await visit(page, web.origin + "/channels/security/agent");
    await expect(page.getByText(web.origin + "/api/mcp/spaces/security", { exact: true })).toBeVisible();
    await expect(page.getByText(web.origin + "/channels/security/feed.xml", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".data/dev-setup/dev04-screens/channel-mobile.png", fullPage: true });
    await visit(page, web.origin + "/channels/security/hot");
    await expect(page.getByText("过去 48 小时讨论最多的 10 件事", { exact: false })).toBeVisible();
    await expect(page.getByText(/AI 圈讨论最多/)).toHaveCount(0);
    await page.screenshot({ path: ".data/dev-setup/dev04-screens/channel-mobile-hot.png", fullPage: true });
  } finally { await context.close(); }
});

test("unknown channels and missing reports fail closed and old URLs stay default", async () => {
  for (const path of ["/channels/unknown", "/channels/stopped/more", "/channels/unknown/daily/2026-10-04", "/channels/security/daily/2026-09-30", "/channels/hardware/daily/not-a-date"]) {
    const response = await fetch(web.origin + path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(await response.text(), /默认频道文章/);
  }
  const malformed = await fetch(web.origin + "/channels/%E0%A4%A/items/shared-item");
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /默认频道正文/);
  const [defaultPage, securityPage] = await Promise.all([fetch(web.origin + "/items/shared-item"), fetch(web.origin + "/channels/security/items/shared-item")]);
  assert.match(await defaultPage.text(), /默认频道正文/);
  assert.match(await securityPage.text(), /安全测试频道正文/);
  assert.equal((await fetch(web.origin + "/channels/security/feed.xml")).status, 200);
});


for (const device of ["desktop", "phone"] as const) {
  test(`${device} report navigation, archives and schedules stay in the selected channel`, async () => {
    const phone = device === "phone";
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const openDaily = () => page.getByRole("navigation", { name: phone ? "底部导航" : "主导航" }).getByRole("link", { name: "日报", exact: true }).click();
    try {
      await visit(page, web.origin + "/channels/security");
      await openDaily();
      await expect(page).toHaveURL(web.origin + "/channels/security/daily");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("安全测试频道 日报");
      await expect(page.getByRole("heading", { name: reportHeadline("安全测试频道", "2026-10-04"), exact: true })).toBeVisible();
      await expect(page.getByText("安全测试频道独立日报摘要 2026-10-04", { exact: true })).toBeVisible();
      await expect(page.getByText("每天 09:15 出刊", { exact: true })).toBeVisible();
      await expect(page.getByText("每天 16:40 出刊", { exact: true })).toHaveCount(0);
      await expect(page).toHaveTitle(/安全测试频道.*日报/);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", web.origin + "/channels/security/daily");
      await expect(page.locator('link[type="application/rss+xml"][href="/channels/security/feed/daily.xml"]')).toHaveCount(1);
      if (phone) await page.getByRole("navigation", { name: "最近的日报" }).getByRole("link", { name: "更早", exact: true }).click();
      else await page.getByRole("link", { name: "日报合订本", exact: true }).first().click();
      await expect(page).toHaveURL(web.origin + "/channels/security/daily/archive");
      await expect(page.getByRole("heading", { name: "日报合订本", exact: true })).toBeVisible();
      await expect(page).toHaveTitle(/安全测试频道.*历史存档/);
      const archived = page.getByRole("link").filter({ hasText: reportHeadline("安全测试频道", "2026-10-02") }).filter({ visible: true }).last();
      await expect(archived).toHaveAttribute("href", "/channels/security/daily/2026-10-02");
      await archived.click();
      await expect(page).toHaveURL(web.origin + "/channels/security/daily/2026-10-02");
      await expect(page.getByRole("heading", { name: reportHeadline("安全测试频道", "2026-10-02"), exact: true })).toBeVisible();
      await expect(page.getByText("安全测试频道独立日报摘要 2026-10-02", { exact: true })).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", web.origin + "/channels/security/daily/2026-10-02");
      await page.screenshot({ path: `.data/dev-setup/dev05-screens/channel-report-${device}.png`, fullPage: true, animations: "disabled" });
      await page.getByRole("combobox", { name: "切换频道" }).filter({ visible: true }).selectOption("hardware");
      await expect(page).toHaveURL(web.origin + "/channels/hardware");
      await openDaily();
      await expect(page.getByRole("heading", { name: reportHeadline("硬件测试频道", "2026-10-04"), exact: true })).toBeVisible();
      await expect(page.getByText("硬件测试频道独立日报摘要 2026-10-04", { exact: true })).toBeVisible();
      await expect(page.getByText("每天 16:40 出刊", { exact: true })).toBeVisible();
      await expect(page.getByText("每天 09:15 出刊", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /安全测试频道日报要闻/ })).toHaveCount(0);
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /硬件测试频道.*日报/);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", web.origin + "/channels/hardware/daily");
      await page.getByRole("combobox", { name: "切换频道" }).filter({ visible: true }).selectOption("security");
      await expect(page).toHaveURL(web.origin + "/channels/security");
      await openDaily();
      await expect(page.getByRole("heading", { name: reportHeadline("安全测试频道", "2026-10-04"), exact: true })).toBeVisible();
      await expect(page.getByText("每天 09:15 出刊", { exact: true })).toBeVisible();
      assert.ok(requests.includes("/api/site/spaces/security/reports/daily/latest-page"));
      assert.ok(requests.includes("/api/site/spaces/hardware/reports/daily/latest-page"));
      assert.ok(requests.includes("/api/site/spaces/security/reports/daily/navigation/2026-10-02"));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
