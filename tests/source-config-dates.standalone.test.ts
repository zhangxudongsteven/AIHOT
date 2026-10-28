// An onboarding boundary must remain an exact instant on every host; malformed or rounded-over
// dates must be refused before a source could accidentally collect and analyse its whole archive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

test("ordinary listing sources accept an exact UTC publication boundary", () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    for (const publishedAfter of ["2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00Z", "2024-02-29T23:59:59.999Z"]) {
      assert.deepEqual(unsupportedConfig(kind, { publishedAfter }), []);
    }
  }
});

test("a publication boundary rejects missing zones, incomplete and impossible dates, and non-string values", () => {
  for (const publishedAfter of ["2026-09-28", "2026-09-28T00:00:00", "September 28, 2026", "2026-02-30T00:00:00Z", "2026-09-28T24:00:00Z", "2026-13-01T00:00:00Z", "", null, 1790553600000]) {
    assert.deepEqual(unsupportedConfig("web_list", { publishedAfter }), ["publishedAfter"], String(publishedAfter));
  }
});

test("channels that do not apply the publication boundary refuse it instead of ignoring it", () => {
  for (const kind of ["x_search", "mp_account", "external"] as const) {
    assert.deepEqual(unsupportedConfig(kind, { publishedAfter: "2026-09-28T00:00:00Z" }), ["publishedAfter"]);
  }
});

test("RSS can name the timezone of a date-only feed entry", () => {
  assert.deepEqual(unsupportedConfig("rss", { publishedAtUtcOffset: "+00:00" }), []);
});

test("RSS content publication rules must be valid explicit regular expressions", () => {
  assert.deepEqual(unsupportedConfig("rss", { publishedAtContentRegex: "Published:\\s*(\\d{4}-\\d{2}-\\d{2})" }), []);
  for (const publishedAtContentRegex of ["", "[", null, true]) {
    assert.deepEqual(unsupportedConfig("rss", { publishedAtContentRegex }), ["publishedAtContentRegex"]);
  }
  assert.deepEqual(unsupportedConfig("json_list", { publishedAtContentRegex: "(.*)" }), ["publishedAtContentRegex"]);
});

test("the structured MSRC body adapter is explicit and limited to RSS sources", () => {
  assert.deepEqual(unsupportedConfig("rss", { bodyAdapter: "msrc_csaf" }), []);
  assert.deepEqual(unsupportedConfig("rss", { bodyAdapter: "unknown" }), ["bodyAdapter=unknown"]);
  assert.deepEqual(unsupportedConfig("web_list", { bodyAdapter: "msrc_csaf" }), ["bodyAdapter"]);
});

test("JSON external identity is opt-in and requires an explicit external ID path", () => {
  assert.deepEqual(unsupportedConfig("json_list", { externalIdPath: "id", identityByExternalId: true }), []);
  assert.deepEqual(unsupportedConfig("json_list", { identityByExternalId: true }), ["identityByExternalId"]);
  assert.deepEqual(unsupportedConfig("json_list", { externalIdPath: "id", identityByExternalId: "true" }), ["identityByExternalId"]);
  assert.deepEqual(unsupportedConfig("rss", { identityByExternalId: true }), ["identityByExternalId"]);
});

test("the CISA KEV JSON adapter accepts only its official fixed catalog endpoints", () => {
  const official = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
  const github = "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json";
  for (const url of [official, github]) {
    assert.deepEqual(unsupportedConfig("json_list", { adapter: "cisa_kev", url }), []);
  }
  for (const url of [
    "http://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    "https://example.org/known_exploited_vulnerabilities.json",
    "https://www.cisa.gov.example.org/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
    official + "?catalog=kev", official + "#entry", official.replace("https://", "https://user:password@"),
    github.replace("/develop/", "/main/"), "", null,
  ]) {
    assert.ok(unsupportedConfig("json_list", { adapter: "cisa_kev", url }).includes("url"), String(url));
  }
  for (const kind of ["rss", "web_list"] as const) {
    assert.ok(unsupportedConfig(kind, { adapter: "cisa_kev", url: official }).length > 0, kind);
  }
  assert.ok(unsupportedConfig("json_list", { adapter: "mimo_home", url: official }).length > 0);
  assert.ok(unsupportedConfig("json_list", { adapter: "unknown", url: official }).length > 0);
});

test("RSS entry URL rules require a valid regular expression and do not apply to other source kinds", () => {
  assert.deepEqual(unsupportedConfig("rss", { itemUrlContentRegex: "https://www\\.debian\\.org/security/\\d{4}/dsa-\\d+" }), []);
  for (const itemUrlContentRegex of ["", "[", null, true]) {
    assert.deepEqual(unsupportedConfig("rss", { itemUrlContentRegex }), ["itemUrlContentRegex"]);
  }
  for (const kind of ["json_list", "web_list"] as const) {
    assert.deepEqual(unsupportedConfig(kind, { itemUrlContentRegex: "https://example\\.org/([^ ]+)" }), ["itemUrlContentRegex"]);
  }
});
