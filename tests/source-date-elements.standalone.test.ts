// Real listing date labels can carry a Unix debugging tooltip, while detail rules can select a
// metadata element. Unlabelled or modified times must not stand in for a publication date.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { fetchMsrcCsaf } from "@aihot/backend/sources/msrc";
import { fetchDetail, fromHtml } from "@aihot/backend/sources/web-list";

const html = `<html><head><meta name="date" content="2026-09-11T19:58:33Z"></head><body>` +
  `<article><a href="/post">A real article</a><span title="Unix: 1789171113866">Sep 11, 2026</span></article></body></html>`;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/modified") return res.end(`<meta property="article:modified_time" content="2026-10-14T00:00:00Z"><time itemprop="dateModified" datetime="2026-10-14T00:00:00Z">Updated today</time>`);
  if (req.url === "/unlabelled") return res.end(`<time datetime="2026-10-14T00:00:00Z">2026-10-14</time>`);
  if (req.url === "/published") return res.end(`<time itemprop="datePublished" datetime="2020-02-15T00:00:00Z">Published February 15, 2020</time>`);
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a listing uses the visible date when its tooltip is not a publication date", () => {
  const items = fromHtml(html, base, { config: { url: base, itemSelector: "article", publishedAtSelector: "span[title^='Unix:']", publishedAtUtcOffset: "+00:00" } } as never);
  assert.equal(items[0]!.publishedAt?.toISOString(), "2026-09-11T00:00:00.000Z");
});

test("a listing's explicit date element reads relative labels with their source precision", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T10:30:00Z") });
  const labels = ["47小时前", "2天前", "版面之外·今天 15:46", "16h ago"];
  const listing = labels.map((label, i) => `<article><a href="/post-${i}">Post ${i}</a><span>${label}</span></article>`).join("");
  const items = fromHtml(listing, base, { config: { url: base, itemSelector: "article", publishedAtSelector: "span" } } as never);
  assert.deepEqual(items.map(({ publishedAt, publicationTime }) => ({ publishedAt: publishedAt?.toISOString(), publicationTime })), [
    { publishedAt: "2026-10-22T11:30:00.000Z", publicationTime: "2026-10-22T11:30:00.000Z" },
    { publishedAt: "2026-10-21T16:00:00.000Z", publicationTime: "2026-10-22" },
    { publishedAt: "2026-10-24T07:46:00.000Z", publicationTime: "2026-10-24T07:46:00.000Z" },
    { publishedAt: "2026-10-23T18:30:00.000Z", publicationTime: "2026-10-23T18:30:00.000Z" },
  ]);
});

test("absolute date metadata takes precedence over a relative label; unrelated prose is no date", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T01:30:00Z") });
  const listing = '<article><a href="/dated">Dated</a><time datetime="2026-10-20">2天前</time></article>' +
    '<article><a href="/undated">Undated</a><time>两天前开业的店</time></article>';
  const items = fromHtml(listing, base, { config: { url: base, itemSelector: "article", publishedAtSelector: "time", publishedAtUtcOffset: "-03:00" } } as never);
  assert.equal(items[0]!.publishedAt?.toISOString(), "2026-10-20T03:00:00.000Z");
  assert.equal(items[0]!.publicationTime, "2026-10-20");
  assert.equal(items[1]!.publishedAt, null);
  assert.equal(items[1]!.publicationTime, null);
});

test("a detail date selector reads meta content and an invalid tooltip does not mask visible text", async () => {
  for (const [publishedAtSelector, expected] of [["meta[name='date']", "2026-09-11T19:58:33.000Z"], ["span", "2026-09-11T00:00:00.000Z"]]) {
    const item = await fetchDetail(base + "/post", { config: { detail: { publishedAtSelector, publishedAtAuthoritative: true, publishedAtUtcOffset: "+00:00" } } } as never, { date: true, title: false, summary: false });
    assert.equal(item.publishedAt?.toISOString(), expected);
  }
});

// An article can put its update time first; only explicit publication metadata or a source rule is trusted.
test("generic detail metadata does not promote modified or unlabelled time elements to publication", async () => {
  const source = { config: { detail: { maxFetches: 1 } } } as never;
  for (const path of ["/modified", "/unlabelled"]) {
    const detail = await fetchDetail(base + path, source, { date: true, title: false, summary: false });
    assert.equal(detail.publishedAt, null, path);
  }
  const published = await fetchDetail(base + "/published", source, { date: true, title: false, summary: false });
  assert.equal(published.publishedAt?.toISOString(), "2020-02-15T00:00:00.000Z");
});

test("MSRC CSAF uses the CVE's original release and retains vendor impact, products and fixes", async () => {
  const previousDispatcher = getGlobalDispatcher();
  const previousProxy = config.egressProxyUrl;
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  config.egressProxyUrl = null;
  const cve = "CVE-2026-70338";
  const path = "/csaf/advisories/2026/msrc_cve-2026-70338.json";
  const url = `https://msrc.microsoft.com/update-guide/vulnerability/${cve}`;
  const document = {
    document: { title: "PowerShell security feature bypass", tracking: { initial_release_date: "2026-08-11T07:00:00Z", current_release_date: "2026-10-26T07:00:00Z" }, aggregate_severity: { text: "Important" } },
    product_tree: { branches: [{ branches: [{ product: { product_id: "powershell", name: "PowerShell 7.4 before 7.4.19" } }] }] },
    vulnerabilities: [{ cve, notes: [{ title: "Impact", text: "An attacker could bypass application control restrictions. <script>unsafe()</script><a href='javascript:unsafe()'>Unsafe URL</a>" }], product_status: { known_affected: ["powershell"] }, threats: [{ category: "exploit_status", details: "Publicly Disclosed:No;Exploited:No" }], remediations: [{ category: "vendor_fix", details: "7.4.19:Security Update", product_ids: ["powershell"] }] }],
  };
  const reply = (value: unknown, status = 200) => agent.get("https://msrc.microsoft.com").intercept({ path }).reply(status, JSON.stringify(value), { headers: { "content-type": "application/json" } });
  try {
    reply(document);
    const body = await fetchMsrcCsaf(url);
    assert.equal(body.publishedAt?.toISOString(), "2026-08-11T07:00:00.000Z");
    assert.equal(body.via, "msrc_csaf");
    assert.match(body.text, /PowerShell 7\.4 before 7\.4\.19/);
    assert.match(body.text, /7\.4\.19:Security Update/);
    assert.match(body.text, /Publicly Disclosed:No;Exploited:No/);
    assert.ok(body.html.includes(url));
    assert.doesNotMatch(body.html, /<script|javascript:/);
    reply({ ...document, vulnerabilities: [{ ...document.vulnerabilities[0], cve: "CVE-2026-99999" }] });
    await assert.rejects(fetchMsrcCsaf(url), /does not match/);
    reply({ ...document, document: { ...document.document, tracking: { initial_release_date: "2026-02-30T07:00:00Z" } } });
    await assert.rejects(fetchMsrcCsaf(url), /publication date is invalid/);
    reply({ ...document, document: { ...document.document, tracking: { current_release_date: "2026-10-26T07:00:00Z" } } });
    await assert.rejects(fetchMsrcCsaf(url), /incomplete/);
    reply({}, 404);
    await assert.rejects(fetchMsrcCsaf(url), /HTTP 404/);
    await assert.rejects(fetchMsrcCsaf("https://example.org/update-guide/vulnerability/CVE-2026-70338"), /official vulnerability URL/);
  } finally {
    config.egressProxyUrl = previousProxy;
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  }
});
