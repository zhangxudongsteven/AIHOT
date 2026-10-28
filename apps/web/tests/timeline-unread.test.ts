// Failure modes fixed before adding the timeline's reader-side unread filter (issue #185):
// - a page whose cards are all read shows nothing and stops, instead of paging on and handing the
//   rest back to the button;
// - a failed page is not offered for retry, or retrying loses the filter;
// - a reading group disappears because its representative is read, or a fully read one stays;
// - returning to the list drops the filter, or an ordinary card survives it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { FIXTURE_AT as at, fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const earlier = "2026-10-03T08:00:00.000Z";

const summaryOf = (id: string, title: string, timelineAt = at) => feedItem({ id, title, publishedAt: timelineAt, timelineAt });
const card = (id: string, title: string, timelineAt = at) => ({ key: id, anchorAt: timelineAt, item: summaryOf(id, title, timelineAt), group: null });
// A reading group whose representative is read but whose other selected report is not: the filter
// must keep it, or the unread report behind the representative would be unreachable.
const groupCard = { key: "g1", anchorAt: at, item: summaryOf("rep-1", "代表文章"), group: { factId: "f1", additionalSourceCount: 1, reportCount: 2, memberIds: ["rep-1", "member-2"] } };
// ...and one whose every selected report is read: it must go.
const readGroupCard = { key: "g2", anchorAt: at, item: summaryOf("rep-3", "已读完的组"), group: { factId: "f2", additionalSourceCount: 1, reportCount: 2, memberIds: ["rep-3", "member-4"] } };
const dateOnlyAt = "2026-10-04T00:00:00.000Z";
const dateReport = { id: "story-date", title: "日期事件报道", summary: "日期报道摘要", source: { name: "Fixture", firstParty: true }, publishedAt: dateOnlyAt, publicationTime: "2026-10-04", selected: true };
const exactReport = { ...dateReport, id: "story-exact", title: "准确事件报道", publicationTime: dateOnlyAt };

let web: WebServer;
let origin: string;
let chrome: Browser;
let failNextPage = false;

const api = fakeApi((url, res) => {
  const p = url.pathname;
  if (p === "/api/site/topics") return { groups: [], topics: [] };
  if (p === "/api/site/hot") return { computedAt: at, windowHours: 48, entries: [] };
  if (p === "/api/site/pool") return {
    filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
    items: [
      feedItem({ id: "pool-date", title: "仅日期列表报道", publishedAt: dateOnlyAt, timelineAt: dateOnlyAt, publicationTime: "2026-10-04" }),
      feedItem({ id: "pool-collected", title: "实时收录列表报道", publishedAt: dateOnlyAt, timelineAt: "2026-10-04T09:35:00.000Z", publicationTime: "2026-10-04" }),
    ], page: 1, pageCount: 1, total: 2, todayCount: 0, freshness: at,
  };
  if (p === "/api/site/stories/date-story") return {
    publicId: "date-story", title: "日期精度事件", status: "settled", reportCount: 2, sourceCount: 1,
    firstReportAt: dateOnlyAt, firstReportTime: "2026-10-04", latestAt: dateOnlyAt, latestTime: "2026-10-04",
    digest: null, digestUpdatedAt: null, summary: null, excerpt: null, latest: dateReport.title, latestReport: { id: dateReport.id },
    whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null },
    developments: [{ factId: "date-fact", title: "日期进展", firstReportAt: dateOnlyAt, firstReportTime: "2026-10-04", reportCount: 2, representative: dateReport }],
    officialReports: [], timeline: [dateReport, exactReport], heat: [], related: [], topics: [],
  };
  if (p === "/api/site/stories/date-story/followups") return { items: [
    { factId: "date-followup", representative: { id: "followup-date", title: "日期后续报道", source: { name: "Fixture" }, timelineAt: dateOnlyAt, timelineTime: "2026-10-04" } },
  ], more: false };
  if (p === "/api/site/timeline") {
    const tag = url.searchParams.get("tag");
    const cursor = url.searchParams.get("cursor");
    if (tag === "dates") {
      return { filters: { channel: "all", category: null, tag }, cards: [
        { ...card("date-anchor", "日期锚点代表", "2026-10-01T00:00:00.000Z"), anchorTime: "2026-10-01", item: summaryOf("date-anchor", "日期锚点代表", "2026-10-02T03:15:00.000Z") },
        { ...card("exact-midnight", "准确零点报道", "2026-10-01T00:00:00.000Z"), anchorTime: "2026-10-01T00:00:00.000Z" },
      ], nextCursor: null, hot: null, dayCounts: { "2026-10-01": 2 } };
    }
    if (tag === "boundary") {
      const n = cursor ? Number(cursor) : 1;
      return { filters: { channel: "all", category: null, tag }, cards: [card(`boundary-${n}`, `批次 ${n}`)], nextCursor: n < 5 ? String(n + 1) : null, hot: null, dayCounts: { "2026-10-04": 5 } };
    }
    if (tag === "group") {
      return { filters: { channel: "all", category: null, tag: "group" }, cards: [groupCard, readGroupCard], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 2 } };
    }
    if (tag === "read") {
      return { filters: { channel: "all", category: null, tag: "read" }, cards: [card("c1", "第一页文章甲")], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } };
    }
    if (cursor === "p2") {
      if (failNextPage) { res.statusCode = 503; return { code: "unavailable" }; }
      return { filters: { channel: "all", category: null, tag: null }, cards: [card("c3", "第二页文章甲", earlier), card("c4", "第二页文章乙", earlier)], nextCursor: null, hot: null, dayCounts: { "2026-10-03": 2 } };
    }
    return { filters: { channel: "all", category: null, tag: null }, cards: [card("c1", "第一页文章甲"), card("c2", "第一页文章乙")], nextCursor: "p2", hot: null, dayCounts: { "2026-10-04": 2 } };
  }
  if (p === "/api/site/groups/f1/reports") {
    const report = (id: string, title: string) => ({ id, title, source: { name: "Fixture" }, timelineAt: at, originalUrl: `https://example.org/${id}` });
    return { factId: "f1", reports: [report("rep-1", "代表文章"), { ...report("member-2", "组内未读报道"), timelineTime: "2026-10-04" }, report("other-5", "组内已读报道")] };
  }
  if (p.startsWith("/api/site/items/")) {
    const id = p.split("/").at(-1)!;
    return itemDetail({ id, title: `文章 ${id}`, originalTitle: `文章 ${id}`, ...(id === "story-parent" ? { story: { publicId: "date-story", title: "日期精度事件" } } : {}) });
  }
});

for (const phone of [false, true]) test(`source precision controls the ${phone ? "phone" : "desktop"} timeline clock rather than the representative's date`, async () => {
  const context = await chrome.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await visit(page, `${origin}/?tag=dates`);
    await expect(page.locator('[data-card-key="date-anchor"] time').filter({ visible: true })).toHaveText(phone ? "· 10月1日" : "10月1日");
    await expect(page.locator('[data-card-key="exact-midnight"] time').filter({ visible: true })).toHaveText(phone ? "· 08:00" : "08:00");
  } finally {
    await context.close();
  }
});

test("a pre-precision timeline snapshot is discarded, and a fresh dated response survives back navigation", async () => {
  const context = await chrome.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((legacy) => {
    if (location.pathname !== "/") return;
    history.replaceState({ ...history.state, key: "legacy-dates", idx: 0 }, "");
    sessionStorage.setItem("aihot:list:legacy-dates", JSON.stringify({ savedAt: Date.now(), data: legacy, anchor: null, scrollY: 0 }));
  }, { version: 2, cards: [card("legacy-date", "旧精度缓存", dateOnlyAt)], nextCursor: null, dayCounts: { "2026-10-04": 1 }, collapsed: [], batches: 1, unreadOnly: false });
  const page = await context.newPage();
  try {
    await visit(page, `${origin}/?tag=dates`);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("heading", { name: "旧精度缓存", exact: true })).toHaveCount(0);
    const date = page.locator('[data-card-key="date-anchor"] time').filter({ visible: true });
    await expect(date).toHaveText("10月1日");
    await page.getByRole("link", { name: "日期锚点代表", exact: true }).click();
    await expect(page.getByText("固定正文", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(date).toHaveText("10月1日");
  } finally {
    await context.close();
  }
});

for (const phone of [false, true]) test(`date-only pool and story reports keep their precision on ${phone ? "phones" : "desktop"}`, async () => {
  const context = await chrome.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await visit(page, `${origin}/all`);
    const row = (title: string) => page.locator("li", { has: page.getByRole("heading", { name: title, exact: true }) }).locator("time").filter({ visible: true });
    await expect(row("仅日期列表报道")).toHaveText(phone ? "· 10月4日" : "10月4日");
    await expect(row("实时收录列表报道")).toHaveText(phone ? "· 17:35" : "17:35");
    await visit(page, `${origin}/story/date-story`);
    const reportTime = (title: string) => page.locator("li", { has: page.getByRole("link", { name: title, exact: true }) }).locator("time");
    await expect(reportTime("日期事件报道")).toHaveText("10月4日");
    await expect(reportTime("日期事件报道")).toHaveAttribute("datetime", "2026-10-04");
    await expect(reportTime("准确事件报道")).toHaveText("08:00");
    await visit(page, `${origin}/items/story-parent`);
    const followup = page.getByRole("link", { name: /日期后续报道/ });
    await expect(followup).toBeVisible();
    await expect(followup).toContainText("2026-10-04");
  } finally {
    await context.close();
  }
});

before(async () => {
  const started = await Promise.allSettled([
    startWebServer(api).then((w) => { web = w; origin = w.origin; }),
    chromium.launch({ channel: "chromium" }).then((b) => { chrome = b; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});

after(async () => {
  await chrome?.close();
  await web?.stop();
});

/** A reader who has already opened these reports, in this browser only. */
async function readerWith(read: string[]) {
  const context = await chrome.newContext();
  await context.addInitScript((ids) => {
    try { window.localStorage.setItem("aihot-read-items", JSON.stringify(ids)); } catch { /* storage unavailable */ }
  }, read);
  return context;
}

test("an all-read page keeps paging, then hides the read cards and shows the unread one", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    // Both loaded cards are read: the list pages on by itself and lands on the unread report.
    await expect(page.getByRole("link", { name: "第二页文章甲", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "第一页文章甲", exact: true }).count(), 0, "a read card is hidden");
    assert.equal(await page.getByRole("button", { name: "只看未读" }).getAttribute("aria-pressed"), "true");
  } finally {
    await context.close();
  }
});

test("a page that fails to load offers a retry that keeps the filter", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  failNextPage = true;
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    const retry = page.getByRole("button", { name: "加载失败，点此重试" });
    await expect(retry).toBeVisible();
    failNextPage = false;
    await retry.click();
    await expect(page.getByRole("link", { name: "第二页文章甲", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("button", { name: "只看未读" }).getAttribute("aria-pressed"), "true", "retrying keeps the filter");
  } finally {
    failNextPage = false;
    await context.close();
  }
});

test("returning to the list keeps the filter and finds the unread report again", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    const opened = page.getByRole("link", { name: "第二页文章甲", exact: true });
    await expect(opened).toBeVisible();
    // Opening a card marks it read in this browser, so the return has to find the other unread one.
    await opened.click();
    await expect(page.getByText("固定正文", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("button", { name: "只看未读" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "第二页文章乙", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "第二页文章甲", exact: true }).count(), 0, "the report just opened stays hidden");
  } finally {
    await context.close();
  }
});

test("a group stays while any selected report in it is unread, and goes once all are read", async () => {
  const context = await readerWith(["rep-1", "rep-3", "member-4"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=group`);
    await expect(page.getByRole("link", { name: "代表文章", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    await expect(page.getByRole("link", { name: "代表文章", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "已读完的组", exact: true }).count(), 0, "a fully read group is hidden");
  } finally {
    await context.close();
  }
});

// A group kept for its unread reports must not look read, and opening it shows which reports are
// still unread (read ones in the same grey as read cards).
for (const phone of [false, true]) test(`a kept group is not greyed and its ${phone ? "sheet" : "expansion"} marks the unread reports`, async () => {
  const context = await readerWith(["rep-1", "other-5"]);
  const page = await context.newPage();
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  // The title text itself is drawn in the read grey (the source line beside it always is).
  const greyed = (name: string) => page.evaluate((text) => {
    const node = [...document.querySelectorAll("a, a *")].find((e) => e.childElementCount === 0 && e.textContent === text && (e as HTMLElement).offsetParent)!;
    const probe = document.body.appendChild(Object.assign(document.createElement("span"), { className: "text-ink-4" }));
    const grey = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(node).color === grey;
  }, name);
  try {
    await page.goto(`${origin}/?tag=group`);
    await page.getByRole("button", { name: "只看未读" }).click();
    const title = page.getByRole("heading", { name: "代表文章" });
    await expect(title).toBeVisible();
    assert.equal(await greyed("代表文章"), false, "the kept group's card is not greyed");
    await page.locator("article", { has: title }).getByRole("button", { name: "另外 1 家也报道了" }).filter({ visible: true }).click();
    await expect(page.getByText("组内未读报道", { exact: true }).filter({ visible: true })).toBeVisible();
    assert.equal(await greyed("组内未读报道"), false, "an unread report keeps the normal colour");
    assert.equal(await greyed("组内已读报道"), true, "a read report is grey");
    if (phone) await expect(page.getByText("Fixture · 10月4日", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("with everything read and no more pages, the filter says so instead of looking empty", async () => {
  const context = await readerWith(["c1"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=read`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    await expect(page.getByText("没有未读的精选内容", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("all-read pages stop at the automatic bound and can continue manually without changing local records", async () => {
  const context = await readerWith(["boundary-1", "boundary-2", "boundary-3", "boundary-4"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=boundary`);
    const raw = await page.evaluate(() => localStorage.getItem("aihot-read-items"));
    await page.getByRole("button", { name: "只看未读" }).click();
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(more).toBeVisible();
    await expect(page.getByText("这批精选都读过了", { exact: true })).toBeVisible();
    await more.click();
    await expect(page.getByRole("link", { name: "批次 5", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.getItem("aihot-read-items")), raw);
  } finally { await context.close(); }
});
