// Channel settings use the real web router with a local HTTP API; no external calls.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { load } from "cheerio";
import type { AdminSpaceNotifyTarget, BeforeJson } from "@aihot/contracts/admin";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

let web: WebServer;
const spaces = [
  { id: "default", slug: "default", name: "AI", enabled: true, failedSources: 0 },
  { id: "security", slug: "security", name: "网络安全", enabled: true, failedSources: 0 },
];
const stamp = "2026-10-28T00:00:00.000Z";
const budgets = new Map(spaces.map(s => [s.id, { space_id: s.id, service: "llm", per_minute: s.id === "default" ? 10 : 7, per_hour: 100, per_day: 300, reserved_minute: 1, reserved_hour: 2, reserved_day: 3, used_minute: 1, used_hour: 2, used_day: 3, note: null, updated_at: stamp }]));
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
const targets = new Map<string, BeforeJson<AdminSpaceNotifyTarget>>(spaces.map(s => [s.id, { key: s.id === "default" ? "feishu-content-main" : `space:${s.id}:feishu-content-main`, targetName: "feishu-content-main", groupId: "main", space_id: s.id, subject_kinds: ["selected"], purpose: "content", kind: "feishu_webhook", enabled: false, enabled_at: null, config_ref: "EXISTING_GROUP", note: null, updated_at: stamp, deliveries_7d: 0, last_sent_at: null }]));
let configured = true;
let budgetGate: Promise<void> | null = null;
let revision = 0;
const api = fakeApi(async (url, _res, req) => {
  if (url.pathname === "/api/site/meta") return { changelogVersion: "2026-10-28T00:00" };
  if (url.pathname === "/api/admin/me") return { name: "Operator", csrf: "test-csrf", dev: false };
  if (url.pathname === "/api/admin/nav-counts") return {};
  if (url.pathname === "/api/admin/spaces") return { spaces };
  if (url.pathname === "/api/admin/settings") return { contact: { wechatQr: null, feishuQr: null }, budgets: [], targets: [...targets.values()] };
  const match = /^\/api\/admin\/spaces\/(default|security)\/(settings|budgets\/llm|content-subscription)$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    if (action === "settings") return { space: spaces.find(s => s.id === id), budgets: budgets.has(id!) ? [budgets.get(id!)] : [], targets: [targets.get(id!)], platformBudgets: [{ service: "llm", per_minute: 20, per_hour: 200, per_day: 600, used_hour: 4, used_day: 5, updated_at: stamp, note: null }], pushGroups: [{ id: "main", label: "现有飞书群", configured }], gates: { collectEnabled: false, modelCallsEnabled: false, contentPushEnabled: false } };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    writes.push({ path: url.pathname, body });
    if (action === "budgets/llm" && budgetGate) await budgetGate;
    const updated_at = new Date(Date.parse(stamp) + ++revision * 1000).toISOString();
    if (action === "budgets/llm") {
      const previous = budgets.get(id!)!;
      const next = { ...previous, per_minute: body.perMinute, per_hour: body.perHour, per_day: body.perDay,
        reserved_minute: body.reservedMinute ?? previous.reserved_minute,
        reserved_hour: body.reservedHour ?? previous.reserved_hour,
        reserved_day: body.reservedDay ?? previous.reserved_day, updated_at };
      budgets.set(id!, next);
      return next;
    }
    const current = targets.get(id!)!;
    const next = { ...current, groupId: body.groupId ?? current.groupId, enabled: body.enabled, subject_kinds: body.subjectKinds, updated_at };
    targets.set(id!, next);
    return next;
  }
  return {};
});
before(async () => { web = await startWebServer(api); });
after(() => web.stop());

test("channel quota edits retain reservations and do not change the other channel", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await visit(page, `${web.origin}/admin/channels/security/quotas`);
    await expect(page.getByRole("heading", { name: "网络安全 · 模型请求额度", exact: true })).toBeVisible();
    await expect(page.getByLabel("每分钟", { exact: true })).toHaveValue("7");
    await page.getByLabel("每分钟", { exact: true }).fill("9");
    // An operator changes reservations after this page loaded, before its ceiling edit is saved.
    budgets.set("security", { ...budgets.get("security")!, reserved_minute: 2, reserved_hour: 3, reserved_day: 4 });
    await page.getByRole("button", { name: "保存额度", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("隔离额度回归");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const saved = budgets.get("security")!;
    assert.deepEqual([saved.reserved_minute, saved.reserved_hour, saved.reserved_day], [2, 3, 4]);
    assert.equal(budgets.get("default")!.per_minute, 10);
    await page.getByRole("combobox", { name: "管理范围", exact: true }).selectOption("default");
    await expect(page).toHaveURL(/\/admin\/channels\/default\/quotas$/);
    await expect(page.getByLabel("每分钟", { exact: true })).toHaveValue("10");
  } finally { await browser.close(); }
});

test("a pending quota save cannot discard newer edits by closing its dialog", async () => {
  let release!: () => void;
  budgetGate = new Promise<void>(resolve => { release = resolve; });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await visit(page, `${web.origin}/admin/channels/security/quotas`);
    await page.getByLabel("每分钟", { exact: true }).fill("12");
    await page.getByRole("button", { name: "保存额度", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("延迟保存回归");
    const before = writes.length;
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => writes.length).toBeGreaterThan(before);
    await expect(page.getByLabel("每分钟", { exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    release(); budgetGate = null;
    await expect(dialog).not.toBeVisible();
    await expect(page.getByLabel("每分钟", { exact: true })).toBeEnabled();
    await page.getByLabel("每分钟", { exact: true }).fill("13");
    await page.getByRole("combobox", { name: "管理范围", exact: true }).selectOption("default");
    await expect(page.getByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    assert.match(page.url(), /\/security\/quotas$/);
  } finally { release(); budgetGate = null; await browser.close(); }
});

test("channel push saves group IDs and subscriptions without exposing webhook input", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await visit(page, `${web.origin}/admin/channels/security/notifications`);
    await expect(page.getByRole("heading", { name: "网络安全 · 飞书推送", exact: true })).toBeVisible();
    await expect(page.getByText("当前环境推送已关闭", { exact: false })).toBeVisible();
    await page.getByLabel("报告（日报、周报、月报）").check();
    await page.getByLabel("启用此目标").check();
    await page.getByRole("button", { name: "保存推送配置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("隔离订阅回归");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const saved = writes.find(x => x.path.endsWith("/security/content-subscription"))!;
    assert.equal(saved.body.groupId, "main");
    assert.deepEqual(saved.body.subjectKinds, ["selected", "report"]);
    assert.equal(saved.body.enabled, true);
    assert.ok(!("configRef" in saved.body) && !("webhook" in saved.body));
    assert.deepEqual(targets.get("default")!.subject_kinds, ["selected"]);
    await expect(page.locator('input[type="url"]')).toHaveCount(0);
  } finally { await browser.close(); }
});

test("an absent channel quota is not displayed as a stopped zero budget", async () => {
  const previous = budgets.get("security")!;
  budgets.delete("security");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await visit(page, `${web.origin}/admin/channels/security/quotas`);
    await expect(page.getByText("未单独设置频道额度", { exact: false })).toBeVisible();
    await expect(page.getByLabel("每分钟", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "保存额度", exact: true })).toBeDisabled();
  } finally { budgets.set("security", previous); await browser.close(); }
});

test("platform settings do not mix channel content destinations into platform controls", async () => {
  const response = await fetch(`${web.origin}/admin/settings`);
  assert.equal(response.status, 200);
  const text = load(await response.text())("main").text();
  assert.match(text, /平台设置/);
  assert.ok(!text.includes("space:security:feishu-content-main"));
});

test("missing group credentials prevent enabling and operator targets can only be paused", async () => {
  const original = targets.get("security")!;
  targets.set("security", { ...original, enabled: false });
  configured = false;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await visit(page, `${web.origin}/admin/channels/security/notifications`);
    await expect(page.getByLabel("启用此目标")).toBeDisabled();
    targets.set("security", { ...original, groupId: null, enabled: true });
    await visit(page, `${web.origin}/admin/channels/security/notifications`);
    await expect(page.getByText("此目标由运维配置", { exact: false })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /的飞书群/ })).toHaveCount(0);
    await page.getByRole("button", { name: "停用", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("暂停未登记的历史路由");
    await dialog.getByRole("button", { name: "停用", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const last = writes.at(-1)!;
    assert.equal(last.path, "/api/admin/spaces/security/content-subscription");
    assert.equal(last.body.groupId, null);
    assert.equal(last.body.enabled, false);
  } finally { configured = true; targets.set("security", original); await browser.close(); }
});

test("an unconfigured target slot requires an explicit group choice and stays disabled", async () => {
  const original = targets.get("security")!;
  targets.set("security", { ...original, groupId: null, config_ref: null, enabled: false });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await visit(page, `${web.origin}/admin/channels/security/notifications`);
    const group = page.getByRole("combobox", { name: "内容主群的飞书群" });
    await expect(group).toHaveValue("");
    await expect(page.getByRole("button", { name: "保存推送配置", exact: true })).toBeDisabled();
    await group.selectOption("main");
    await expect(page.getByLabel("启用此目标")).not.toBeChecked();
    await page.getByRole("button", { name: "保存推送配置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("准备关闭的推送目标");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    assert.equal(writes.at(-1)!.body.groupId, "main");
    assert.equal(writes.at(-1)!.body.enabled, false);
  } finally { targets.set("security", original); await browser.close(); }
});
