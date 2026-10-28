// Day headers of the timeline (features/feed/Timeline.tsx). Failure case: an item imported from an archive, dated
// 2019-02-19, sits under a header reading "2月19日", and readers take it for this year's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { monthDay } from "@aihot/contracts/time";
import { fullDateTime, monthDayTime } from "../app/lib/format.ts";
import * as format from "../app/lib/format.ts";

test("a day of today's year has no year; another year's carries it", () => {
  assert.equal(monthDay("2026-10-05", "2026-10-19"), "10月5日");
  assert.equal(monthDay("2019-02-19", "2026-10-19"), "2019年2月19日");
  assert.equal(monthDay("2025-12-31", "2026-01-01"), "2025年12月31日");
});

test("without today, as everywhere else, it stays month and day", () => {
  assert.equal(monthDay("2019-02-19"), "2月19日");
});

test("a source calendar date displays without an invented clock time", () => {
  assert.equal(fullDateTime("2026-10-26"), "2026-10-26");
  assert.equal(monthDayTime("2026-10-26"), "10月26日");
});

test("an exact UTC midnight remains an exact Beijing time", () => {
  assert.equal(fullDateTime("2026-10-26T00:00:00.000Z"), "2026-10-26 08:00");
  assert.equal(monthDayTime("2026-10-26T00:00:00.000Z"), "10月26日 08:00");
  assert.equal(fullDateTime("2026-09-14T16:42:26.000Z"), "2026-09-15 00:42");
});

test("source precision, rather than the timestamp's hour, determines publication display", () => {
  const midnight = "2026-10-26T00:00:00.000Z";
  assert.equal(format.publicationValue(midnight, "2026-10-26"), "2026-10-26");
  assert.equal(format.publicationValue(midnight, midnight), midnight);
  assert.equal(format.publicationValue(midnight, null), midnight);
  assert.equal(format.clockTime("2026-10-26"), "10月26日");
  assert.equal(format.clockTime(midnight), "08:00");
});

test("a real collection time keeps its clock even when the original only supplied a date", () => {
  const original = "2026-10-26T00:00:00.000Z";
  const collected = "2026-10-26T09:35:00.000Z";
  const item = { publishedAt: original, publicationTime: "2026-10-26" };
  assert.equal(format.timelineValue({ ...item, timelineAt: original }), "2026-10-26");
  assert.equal(format.timelineValue({ ...item, timelineAt: collected }), collected);
  assert.equal(format.timelineValue({ publishedAt: null, timelineAt: collected }), collected);
  assert.equal(format.relativeTime("2026-10-26", Date.parse(collected)), "2026-10-26");
});
