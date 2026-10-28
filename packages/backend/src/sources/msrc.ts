import { z } from "zod";
import type { ExtractedBody } from "../content/extract.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { guardedFetch, requireOk } from "../lib/http-fetch.ts";
import { escapeXml, stripTags } from "../lib/text.ts";
import { FetchError } from "./types.ts";

const note = z.object({ title: z.string().optional(), text: z.string() });
const score = z.object({ baseScore: z.number(), vectorString: z.string() });
const advisory = z.object({
  document: z.object({
    title: z.string(),
    tracking: z.object({ initial_release_date: z.string(), current_release_date: z.string().optional() }),
    aggregate_severity: z.object({ text: z.string() }).optional(),
  }),
  product_tree: z.unknown().optional(),
  vulnerabilities: z.array(z.object({
    cve: z.string(), title: z.string().optional(), notes: z.array(note).optional(),
    product_status: z.record(z.string(), z.array(z.string())).optional(),
    threats: z.array(z.object({ category: z.string(), details: z.string() })).optional(),
    remediations: z.array(z.object({ category: z.string(), details: z.string(), url: z.string().optional(), product_ids: z.array(z.string()).optional() })).optional(),
    scores: z.array(z.object({ cvss_v3: score.optional(), cvss_v4: score.optional() })).optional(),
  })),
});

function productNames(tree: unknown, names = new Map<string, string>()): Map<string, string> {
  if (!tree || typeof tree !== "object") return names;
  const node = tree as Record<string, unknown>;
  if (node.product && typeof node.product === "object") {
    const product = node.product as Record<string, unknown>;
    if (typeof product.product_id === "string" && typeof product.name === "string") names.set(product.product_id, product.name);
  }
  if (Array.isArray(node.branches)) for (const branch of node.branches) productNames(branch, names);
  return names;
}

export async function fetchMsrcCsaf(url: string): Promise<ExtractedBody> {
  const source = new URL(url);
  const match = /^\/update-guide\/(?:en-US\/)?vulnerability\/(CVE-(\d{4})-\d+)\/?$/i.exec(source.pathname);
  if (source.protocol !== "https:" || source.hostname !== "msrc.microsoft.com" || source.port || source.username || source.password || !match) throw new FetchError("MSRC CSAF requires an official vulnerability URL");
  const cve = match[1]!.toUpperCase();
  const csafUrl = `https://msrc.microsoft.com/csaf/advisories/${match[2]}/msrc_${cve.toLowerCase()}.json`;
  const response = requireOk(await guardedFetch(csafUrl, { headers: { accept: "application/json" }, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 }), "MSRC CSAF");
  const result = advisory.safeParse(JSON.parse(response.text()));
  if (!result.success) throw new FetchError("MSRC CSAF document is incomplete");
  const document = result.data;
  const vulnerability = document.vulnerabilities.find(item => item.cve.toUpperCase() === cve);
  if (!vulnerability) throw new FetchError("MSRC CSAF document does not match the requested CVE");
  const initial = document.document.tracking.initial_release_date;
  const publishedAt = new Date(initial);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(initial) || !Number.isFinite(publishedAt.getTime()) || publishedAt.toISOString() !== initial.replace(/(?<=\d{2}:\d{2}:\d{2})Z$/, ".000Z")) throw new FetchError("MSRC CSAF original publication date is invalid");
  const names = productNames(document.product_tree);
  const products = (ids: string[]) => ids.map(id => names.get(id) ?? `Product ID ${id}`).join("; ");
  const sections = [
    `<h2>${escapeXml(cve)}: ${escapeXml(vulnerability.title ?? document.document.title)}</h2>`,
    `<p>Originally published: ${escapeXml(initial)}</p>`,
    ...(document.document.tracking.current_release_date ? [`<p>Advisory revision: ${escapeXml(document.document.tracking.current_release_date)}</p>`] : []),
    ...(document.document.aggregate_severity ? [`<p>Vendor severity: ${escapeXml(document.document.aggregate_severity.text)}</p>`] : []),
    ...(vulnerability.notes ?? []).map(item => `${item.title ? `<h3>${escapeXml(item.title)}</h3>` : ""}<p>${item.text}</p>`),
    ...Object.entries(vulnerability.product_status ?? {}).map(([status, ids]) => `<p>${escapeXml(status)}: ${escapeXml(products(ids))}</p>`),
    ...(vulnerability.threats ?? []).map(item => `<p>${escapeXml(item.category)}: ${escapeXml(item.details)}</p>`),
    ...(vulnerability.remediations ?? []).map(item => `<p>${escapeXml(item.category)}: ${escapeXml(item.details)}${item.product_ids?.length ? ` (${escapeXml(products(item.product_ids))})` : ""}${item.url ? ` <a href="${escapeXml(item.url)}">Vendor remediation</a>` : ""}</p>`),
    ...(vulnerability.scores ?? []).flatMap(item => [item.cvss_v3, item.cvss_v4].filter((value): value is z.infer<typeof score> => !!value).map(value => `<p>CVSS: ${value.baseScore} ${escapeXml(value.vectorString)}</p>`)),
    `<p><a href="${escapeXml(source.href)}">MSRC vulnerability</a> · <a href="${csafUrl}">Official CSAF advisory</a></p>`,
  ];
  const html = sanitizeBody(sections.join("\n"), source.href);
  const text = stripTags(html);
  if (text.length < 200) throw new FetchError("MSRC CSAF document has insufficient vulnerability details");
  return { html, text, images: [], via: "msrc_csaf", publishedAt, publicationTime: publishedAt.toISOString() };
}
