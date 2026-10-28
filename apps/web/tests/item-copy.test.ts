// Failure mode: WeChat's in-app browser cannot save downloads, so the article offers "复制 Markdown" there
// instead; it copied with the async clipboard, which that browser does not have, and always failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";
import type { TopicSummary } from "@aihot/contracts/site";

const markdown = "# 复制检查\n\n固定正文";

test("in WeChat, 复制 Markdown copies the article without the async clipboard", async () => {
  const api = fakeApi((url, res) => {
    if (url.pathname === "/api/site/items/wechat-copy") return itemDetail({ id: "wechat-copy", title: "复制检查" });
    if (url.pathname === "/items/wechat-copy/markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      return res.end(markdown);
    }
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
    });
    // As in WeChat: no async clipboard; a selection copy works, and what it copied is kept for the test.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.execCommand = (command: string) => {
        if (command !== "copy") return false;
        (window as { copied?: string }).copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
        return true;
      };
    });
    const page = await context.newPage();
    await visit(page, web.origin + "/items/wechat-copy");
    await page.getByRole("button", { name: "更多操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "复制 Markdown" }).click();
    await expect(page.getByRole("status")).toHaveText("Markdown 已复制");
    assert.equal(await page.evaluate(() => (window as { copied?: string }).copied), markdown);
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("article dates preserve source precision on desktop and phones", async () => {
  const midnight = "2026-10-26T00:00:00.000Z";
  const samples = [
    { id: "calendar-day", publicationTime: "2026-10-26", expected: "2026-10-26", dateTime: "2026-10-26" },
    { id: "exact-midnight", publicationTime: midnight, expected: "2026-10-26 08:00", dateTime: midnight },
    { id: "legacy-time", publicationTime: null, expected: "2026-10-26 08:00", dateTime: midnight },
  ];
  const api = fakeApi((url) => {
    const sample = samples.find(value => url.pathname === `/api/site/items/${value.id}`);
    if (sample) return itemDetail({ id: sample.id, title: `日期精度 ${sample.id}`, publishedAt: midnight, publicationTime: sample.publicationTime });
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    for (const viewport of [{ width: 1720, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        for (const sample of samples) {
          await visit(page, `${web.origin}/items/${sample.id}`);
          const stamp = page.locator("main time:visible");
          await expect(stamp).toHaveCount(1);
          await expect(stamp).toHaveText(sample.expected);
          await expect(stamp).toHaveAttribute("datetime", sample.dateTime);
          const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
          assert.ok(ld.some(value => JSON.stringify(JSON.parse(value)).includes(`"datePublished":"${sample.dateTime}"`)));
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("an existing bookmark recovers date precision from its current public metadata", async () => {
  const id = "old-calendar-bookmark";
  const midnight = "2026-10-26T00:00:00.000Z";
  const api = fakeApi((url) => {
    if (url.pathname === "/api/site/items/availability") return {
      [id]: { status: "public", sourceName: "Fixture", publishedAt: midnight, publicationTime: "2026-10-26" },
    };
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({id, midnight}) => {
      localStorage.setItem("aihot-starred-items", JSON.stringify([{ id, title: "旧日期收藏", sourceName: "Fixture", savedAt: "2026-10-27T01:30:00.000Z", publishedAt: midnight }]));
    }, {id, midnight});
    try {
      const page = await context.newPage();
      await visit(page, web.origin + "/starred");
      const card = page.locator(`[data-card-key="${id}"]`);
      await expect(card).toContainText("2026-10-26");
      await expect(card).not.toContainText("08:00");
    } finally { await context.close(); }
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("topic pages and their directory respect source precision without hiding real ranking or collection times", async () => {
  const midnight = "2026-10-26T00:00:00.000Z";
  const samples = [
    { slug: "calendar-day", at: midnight, time: "2026-10-26", expected: "10月26日" },
    { slug: "exact-midnight", at: midnight, time: midnight, expected: "10月26日 08:00" },
    { slug: "collection-time", at: "2026-10-26T09:35:00.000Z", time: "2026-10-26T09:35:00.000Z", expected: "10月26日 17:35" },
    { slug: "legacy-time", at: midnight, time: undefined, expected: "10月26日 08:00" },
  ];
  const topics: TopicSummary[] = samples.map(sample => ({
    slug: sample.slug, name: `日期主题 ${sample.slug}`, group: "field", definition: "日期精度主题", brand: null,
    total: 1, recent: 1, indexable: false, latest: { title: "日期精度公告", at: sample.at, time: sample.time },
  }));
  const api = fakeApi((url) => {
    if (url.pathname === "/api/site/topics") return { groups: [{ key: "field", name: "技术方向" }], topics };
    const topic = topics.find(topic => url.pathname === `/api/site/topics/${topic.slug}`);
    if (topic) return { topic: { ...topic, groupName: "技术方向", poolTotal: 1 }, modules: {}, items: [], page: 1, pageCount: 1, pageSize: 20 };
    if (url.pathname === "/api/site/hot") return { computedAt: midnight, windowHours: 48, entries: [] };
  });
  const web = await startWebServer(api);
  try {
    for (const sample of samples) {
      const response = await fetch(`${web.origin}/topics/${sample.slug}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      const stamp = /<time\b[^>]*datetime="([^"]+)"[^>]*>([^<]*)<\/time>/i.exec(html);
      assert.equal(stamp?.[1], sample.time ?? sample.at, sample.slug);
      assert.equal(stamp?.[2], sample.expected, sample.slug);
      if (sample.slug === "calendar-day") assert.ok(!html.includes("08:00"));
    }
    const directory = await (await fetch(`${web.origin}/topics`)).text();
    assert.match(directory, /datetime="2026-10-26"[^>]*>2026-10-26<\/time>/i);
    const ranking = await (await fetch(`${web.origin}/hot`)).text();
    assert.ok(ranking.includes("10月26日 08:00"), "the ranking's actual computation clock remains visible");
  } finally { await web.stop(); }
});
