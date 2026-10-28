// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { chromium, expect } from "@playwright/test";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

let web: WebServer;
let origin: string;
let deadline: number;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = fakeApi(async (url, res, req) => {
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/meta") {
    // Past the deadline on the wall clock the server reads: timers run on another clock, and a CI VM
    // stepping its wall clock back mid-wait would otherwise answer before the deadline.
    while (metaAfterDeadline && Date.now() < deadline * 1000 + 50) await new Promise((resolve) => setTimeout(resolve, deadline * 1000 + 50 - Date.now()));
    return { changelogVersion: "2026-09-28T12:00" };
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return { filters, cards: [], nextCursor: null, dayCounts: [], hot: null };
  }
  if (url.pathname === "/api/site/hot") return { entries: [] };
  if (url.pathname === "/api/site/echo-client") return { forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] };
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/long-lived") return { id: "long-lived", title: "t" };
  if (url.pathname === "/api/site/contact") return { wechatQr: "/qr.png", feishuQr: "/qr.png" };
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return { mergedInto: "surviving-story" };
  }
  if (url.pathname.startsWith("/api/admin/")) {
    res.statusCode = 401;
    return { code: "not_found" };
  }
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  web = await startWebServer(api);
  origin = web.origin;
});
after(() => web.stop());

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  // The api's deadline also fixes the result's own expiry, so reads seconds apart compare byte for byte.
  const plain = await fetch(`${origin}/_.data`);
  const signedIn = await fetch(`${origin}/_.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.equal(plain.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /api\/auth\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  const cc = res.headers.get("Cache-Control")!;
  assert.equal(Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]), 300);
  assert.ok(Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]) > 300);
  await res.text();
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
test("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a signed-in admin is sent past the sign-in page", async () => {
  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/admin/me") {
      if (req.headers.cookie?.includes("aihot_admin=fixture")) return { name: "Fixture admin", csrf: "fixture", dev: false };
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    if (url.pathname === "/api/auth/options") return { password: true, feishu: false };
  });
  const signedIn = await startWebServer(api);
  try {
    const res = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin%2Fcontent`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/content");
    await res.text();
    for (const target of ["javascript:alert(1)", "//evil.example/admin", "https://evil.example/admin"]) {
      const away = await fetch(`${signedIn.origin}/admin/login?return=${encodeURIComponent(target)}`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
      assert.equal(away.headers.get("location"), "/admin", target);
      await away.text();
    }
    const anonymous = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin`, { redirect: "manual" });
    assert.equal(anonymous.status, 200, "without a session the page still offers the ways in");
    await anonymous.text();
  } finally {
    await signedIn.stop();
  }
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

// The real listener must own its ephemeral port; reserving and releasing one before spawn races
// another CI process. Canonical URLs still have to identify the listener's actual address.
test("a web server assigned port zero serves its own canonical address", async () => {
  const ephemeral = await startWebServer(fakeApi(), { WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0" });
  try {
    const response = await fetch(`${ephemeral.origin}/about`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`rel="canonical" href="${ephemeral.origin}/about"`));
  } finally { await ephemeral.stop(); }
});

test("admin article diagnostics and both source previews retain date precision and real clocks", async () => {
  const midnight = "2026-10-04T00:00:00.000Z";
  const source = {
    id: "date-source", name: "日期测试源", kind: "rss", tier: "T1", enabled: true, participation_mode: "editorial",
    interval_minutes: 60, first_party: true, signal_group_id: null, owner_entity_id: null, site_fulltext: false,
    syndicate_fulltext: false, tags: [], config: {}, created_at: midnight, updated_at: midnight, next_fetch_at: null,
  };
  const api = fakeApi((url) => {
    if (url.pathname === "/api/admin/me") return { name: "Fixture admin", csrf: "fixture", dev: true };
    if (url.pathname === "/api/admin/spaces") return { spaces: [{ id: "default", slug: "default", name: "AI", enabled: true, failedSources: 0 }] };
    if (url.pathname === "/api/admin/nav-counts") return {};
    if (url.pathname === "/api/admin/spaces/default/sources/date-source") return { source, runs: [], items: [], stats: { total: 0, last7d: 0, selected: 0 }, history: [], republish: null };
    if (url.pathname.endsWith("/preview")) return { ms: 1, count: 2, items: [
      { title: "仅日期预览", url: "https://example.org/day", publishedAt: midnight, publicationTime: "2026-10-04", excerpt: "日期摘要" },
      { title: "准确零点预览", url: "https://example.org/exact", publishedAt: midnight, publicationTime: midnight, excerpt: "时刻摘要" },
    ] };
    if (url.pathname.startsWith("/api/admin/content/")) {
      const id = url.pathname.split("/").at(-1)!;
      return {
        article: { id, source_id: source.id, space_id: "default", source_name: source.name, source_kind: "rss", tier: "T1", participation_mode: "editorial",
          title: "日期诊断", url: `https://example.org/${id}`, identity_key: id, author: null, language: "en", published_at: midnight,
          publication_time: id === "exact" ? midnight : "2026-10-04", published_at_claim: midnight, discovered_at: "2026-10-04T09:35:00.000Z",
          timeline_at: id === "collected" ? "2026-10-04T09:35:00.000Z" : midnight, backfill: id !== "collected", body_status: "ok",
          revision: 1, processing_state: "analyzed", processing_error: null, grouped_at: null, body_chars: 100, site_fulltext: false, syndicate_fulltext: false },
        discoveries: [], revisions: [], analyses: [], publication: null, override: null, ledger: [], membership: [], decisions: [], deliveries: [], history: [],
      };
    }
  });
  const web = await startWebServer(api);
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  try {
    for (const [id, expected] of [
      ["day", "原文时间 2026-10-04 · 时间轴 2026-10-04"],
      ["collected", "原文时间 2026-10-04 · 时间轴 2026-10-04 17:35"],
      ["exact", "原文时间 2026-10-04 08:00 · 时间轴 2026-10-04 08:00"],
    ]) {
      await visit(page, `${web.origin}/admin/content/${id}`);
      await expect(page.getByText(/^原文时间 /)).toHaveText(expected!);
    }
    for (const [path, button] of [["/admin/sources/new", "预览抓取"], ["/admin/sources/date-source", "预览当前配置"]]) {
      await visit(page, web.origin + path);
      await page.getByRole("button", { name: button, exact: true }).click();
      const preview = (name: string) => page.locator("li", { has: page.getByRole("link", { name, exact: true }) });
      await expect(preview("仅日期预览")).toContainText("2026-10-04");
      await expect(preview("仅日期预览")).not.toContainText("08:00");
      await expect(preview("准确零点预览")).toContainText("2026-10-04 08:00");
    }
  } finally {
    await browser.close();
    await web.stop();
  }
});
