import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { readPublicationDate } from "./dates.ts";
import { FetchError, type Candidate } from "./types.ts";

const CATALOG = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";
const FEEDS = new Set([
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json",
]);

/** This adapter reads only CISA's catalog or its official, fixed GitHub mirror. */
export function isCisaKevUrl(value: unknown): boolean {
  return typeof value === "string" && FEEDS.has(value);
}

const text = (value: unknown) => typeof value === "string" ? collapseWhitespace(stripTags(value)) : "";
const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? readPublicationDate(value, "+00:00") : { publishedAt: null, publicationTime: null };

/** Each item is a KEV addition event, rather than a claim about the CVE's first disclosure. */
export function cisaKevCandidates(data: unknown): Candidate[] {
  const rows = data && typeof data === "object" ? (data as { vulnerabilities?: unknown }).vulnerabilities : null;
  if (!Array.isArray(rows)) throw new FetchError("CISA KEV vulnerabilities must be an array");
  const out: Candidate[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const cve = text(item.cveID);
    const added = day(item.dateAdded);
    const due = day(item.dueDate);
    const vendor = text(item.vendorProject), product = text(item.product), name = text(item.vulnerabilityName);
    const description = text(item.shortDescription), action = text(item.requiredAction);
    // An incomplete record must never enter collection as undated material or a generic catalog page.
    if (!/^CVE-\d{4}-\d{4,19}$/.test(cve) || !added.publishedAt || !due.publishedAt || !vendor || !product || !name || !description || !action) continue;
    const bodyText = [
      `CISA KEV addition: ${cve}`,
      `Vendor/project: ${vendor}`,
      `Product: ${product}`,
      `Vulnerability name: ${name}`,
      `Description: ${description}`,
      `KEV dateAdded: ${added.publicationTime}. This is the catalog addition date, not the CVE's first publication or disclosure date; the source gives a calendar day, not an exact time.`,
      `Required action (CISA): ${action}`,
      `CISA dueDate: ${due.publicationTime}. This deadline applies to federal civilian executive branch (FCEB) agencies under the applicable CISA directive; it is not a mandatory deadline for every organization.`,
      `Known ransomware campaign use: ${text(item.knownRansomwareCampaignUse) || "Not provided"}. Unknown means CISA lacks confirmation of ransomware use; it does not mean the vulnerability has not been exploited.`,
      `Notes: ${text(item.notes) || "Not provided"}`,
      ...(text(item.forensicTriage) ? [`Forensic triage (CISA): ${text(item.forensicTriage)}`] : []),
      ...(Array.isArray(item.cwes) ? [`CWEs: ${item.cwes.map(text).filter(Boolean).join(", ")}`] : []),
    ].join("\n\n");
    out.push({
      url: `${CATALOG}?field_cve=${encodeURIComponent(cve)}`,
      title: `CISA KEV addition: ${cve} — ${name}`,
      author: "CISA", language: "en", ...added,
      excerpt: `${cve}: ${description}`.slice(0, 2000),
      bodyText, bodyStatus: "ok", raw: { externalId: cve },
    });
  }
  if (rows.length && !out.length) throw new FetchError("CISA KEV has no complete dated CVE records");
  return out;
}
