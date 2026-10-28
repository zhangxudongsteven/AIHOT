// Atom entry publication and update times stay separate; link bases follow the fetched document URL,
// for RSS items too (Baidu's ERNIE blog feed gives site-relative item links).
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

const entry = (links: string, base = "") => `<entry${base}><id>urn:test:entry</id><title>Research update</title><updated>2026-10-01T00:00:00Z</updated>${links}</entry>`;
const feed = (entries: string, base = "") => `<feed xmlns="http://www.w3.org/2005/Atom"${base}><id>urn:test:feed</id><title>News</title><updated>2026-10-01T00:00:00Z</updated><author><name>Publisher</name></author>${entries}</feed>`;
const pages: Record<string, string> = {
  "/feed-base": feed(entry('<link href="article-1"/>'), ' xml:base="https://publisher.example/news/"'),
  "/entry-base": feed(entry('<link href="article-1"/>', ' xml:base="https://publisher.example/stories/"'), ' xml:base="https://feed.example/"'),
  "/link-base": feed(entry('<link xml:base="https://publisher.example/articles/" href="article-1"/>')),
  "/news/inherited.xml": feed(entry('<link xml:base="../articles/" href="article-1"/>', ' xml:base="stories/"'), ' xml:base="../publisher/"'),
  "/news/feed.xml": feed(entry('<link href="article-1"/>')),
  "/absolute": feed(entry('<link rel="self" href="entry.xml"/><link rel="alternate" href="https://publisher.example/article-1"/>'), ' xml:base="https://feed.example/"'),
  "/fallback": feed(entry('<link rel="related" href="article-1"/>')),
  "/missing": feed(entry("") + entry('<link rel="alternate"/>')),
  "/dates": feed(entry('<link href="undated"/>') + entry('<link href="published"/><published>2020-02-15T00:00:00Z</published>') + entry('<link href="invalid"/><published>unknown</published>')),
  "/rss/feed.xml": `<rss version="2.0"><channel><title>Blog</title><item><title>Release notes</title><link>/blog/zh/posts/release/</link></item><item><title>Elsewhere</title><link>https://publisher.example/post</link></item></channel></rss>`,
  "/fragments": feed(entry('<link href="notes#first"/>') + entry('<link href="notes#second"/>'), ' xml:base="https://publisher.example/"'),
};
const server = http.createServer((req, res) => {
  if (req.url === "/old/feed.xml" || req.url === "/old/rss.xml") {
    res.writeHead(302, { location: req.url === "/old/rss.xml" ? "/rss/feed.xml" : "/news/feed.xml" });
    return res.end();
  }
  res.setHeader("content-type", "application/atom+xml");
  res.end(pages[req.url!] ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(path: string, overrides: Record<string, unknown> = {}) {
  return (await fetchRss({ config: { feedUrl: root + path, ...overrides }, participation_mode: "editorial" } as never)).candidates;
}

test("MSRC revision notices preserve update time while awaiting the official advisory body and publication", async () => {
  pages['/msrc'] = '<rss version="2.0"><channel><item><title>CVE-2026-12345</title><link>https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-12345</link><pubDate>Mon, 26 Oct 2026 14:00:00 GMT</pubDate><description>Updated an acknowledgement.</description></item></channel></rss>';
  const [item] = await read('/msrc', { bodyAdapter: 'msrc_csaf', summaryIsBody: true });
  assert.equal(item!.publishedAt, null);
  assert.equal(item!.sourceUpdatedAt?.toISOString(), '2026-10-26T14:00:00.000Z');
  assert.equal(item!.bodyStatus, 'pending');
  assert.equal(item!.bodyText, null);
  assert.equal(item!.excerpt, 'Updated an acknowledgement.');
});

test("MSRC Atom revisions also wait for the official advisory despite carrying a long body", async () => {
  pages['/msrc-atom'] = feed(entry('<link href="https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-12345"/><content type="html">&lt;p&gt;' + 'Revision details are not the original advisory. '.repeat(20) + '&lt;/p&gt;</content>'));
  const [item] = await read('/msrc-atom', { bodyAdapter: 'msrc_csaf', summaryIsBody: true });
  assert.equal(item!.publishedAt, null);
  assert.equal(item!.sourceUpdatedAt?.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(item!.bodyStatus, 'pending');
  assert.equal(item!.bodyHtml, null);
  assert.equal(item!.bodyText, null);
});

test("an explicit content URL rule selects the advisory's canonical address without falling back to its mail link", async () => {
  const rule = { itemUrlContentRegex: '(https://security-tracker\\.debian\\.org/tracker/DSA-[0-9]+-[0-9]+)' };
  pages['/rss/canonical'] = '<rss version="2.0"><channel><item><title>Security advisory</title><link>https://lists.debian.org/announcement</link><description><![CDATA[<p>Details: https://security-tracker.debian.org/tracker/DSA-1234-1</p>]]></description></item></channel></rss>';
  assert.equal((await read('/rss/canonical'))[0]!.url, 'https://lists.debian.org/announcement');
  assert.equal((await read('/rss/canonical', rule))[0]!.url, 'https://security-tracker.debian.org/tracker/DSA-1234-1');
  pages['/atom/canonical'] = feed(entry('<link href="https://lists.debian.org/announcement"/><content type="html">&lt;p&gt;Details: https://security-tracker.debian.org/tracker/DSA-1234-1&lt;/p&gt;</content>'));
  assert.equal((await read('/atom/canonical', rule))[0]!.url, 'https://security-tracker.debian.org/tracker/DSA-1234-1');
  for (const address of ['missing', 'javascript:alert(1)', 'data:text/plain,advisory', 'https://user:password@example.org/secret']) {
    pages['/rss/invalid-canonical'] = `<rss version="2.0"><channel><item><title>Security advisory</title><link>https://lists.debian.org/announcement</link><description>${address}</description></item></channel></rss>`;
    await assert.rejects(read('/rss/invalid-canonical', { itemUrlContentRegex: address === 'missing' ? 'unmatched(https://.*)' : '(.+)' }), /valid HTTP\(S\) address/);
  }
});

test("Atom article links honor absolute xml:base on feed, entry and link", async () => {
  for (const [path, expected] of [
    ["/feed-base", "https://publisher.example/news/article-1"],
    ["/entry-base", "https://publisher.example/stories/article-1"],
    ["/link-base", "https://publisher.example/articles/article-1"],
  ]) assert.equal((await read(path!))[0]!.url, expected);
});

test("relative xml:base values compose through feed, entry and link", async () => {
  assert.equal((await read("/news/inherited.xml"))[0]!.url, root + "/publisher/articles/article-1");
});

test("relative Atom links use the final document URL after redirects", async () => {
  assert.equal((await read("/old/feed.xml"))[0]!.url, root + "/news/article-1");
});

test("relative RSS item links resolve against the final document URL; absolute ones are kept", async () => {
  assert.deepEqual((await read("/old/rss.xml")).map((item) => item.url), [root + "/blog/zh/posts/release/", "https://publisher.example/post"]);
});

test("absolute alternate links and the first-link fallback keep working", async () => {
  assert.equal((await read("/absolute"))[0]!.url, "https://publisher.example/article-1");
  assert.equal((await read("/fallback"))[0]!.url, root + "/article-1");
  assert.deepEqual(await read("/missing"), []);
});

test("resolved Atom article URLs keep their fragments, which sources of page sections use as identity", async () => {
  const items = await read("/fragments");
  assert.deepEqual(items.map((item) => item.url), ["https://publisher.example/notes#first", "https://publisher.example/notes#second"]);
});

// An edited Atom entry may have no publication time. Using updated can admit an old post as news.
test("Atom update time never substitutes for missing or malformed publication time", async () => {
  const [unknown, published, invalid] = await read("/dates");
  assert.equal(unknown!.publishedAt, null);
  assert.equal(invalid!.publishedAt, null);
  assert.equal(published!.publishedAt?.toISOString(), "2020-02-15T00:00:00.000Z");
  for (const item of [unknown, published, invalid]) {
    assert.equal(item!.sourceUpdatedAt?.toISOString(), "2026-10-01T00:00:00.000Z");
  }
});
