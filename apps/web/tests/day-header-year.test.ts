// Calendar dates across timelines, stories, topics and reports must name another Beijing year.
// A source supplying only a date must keep that precision, including after a year boundary.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { monthDay } from "@aihot/contracts/time";
import { fullDateTime, monthDayTime } from "../app/lib/format.ts";
import * as format from "../app/lib/format.ts";
import { chipLabel, neighbourLabel } from "../app/features/report/format.ts";

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-28T09:00:00+08:00") });
});
afterEach(() => mock.timers.reset());

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

test("the pages name another year without inventing a date-only clock time", () => {
  assert.equal(monthDayTime("2019-02-19T04:00:00.000Z"), "2019年2月19日 12:00");
  assert.equal(monthDayTime("2019-02-19"), "2019年2月19日");
});

test("the phone report chip names another year relative to its supplied today", () => {
  assert.equal(chipLabel("daily", "2027-01-02", [], "2027-01-02"), "今天");
  assert.equal(chipLabel("daily", "2027-01-01", [], "2027-01-02"), "1月1日");
  assert.equal(chipLabel("daily", "2026-12-31", [], "2027-01-02"), "2026年12月31日");
});

test("report neighbours name the year across Beijing midnight", () => {
  mock.timers.setTime(new Date("2026-12-31T23:30:00+08:00").getTime());
  assert.equal(neighbourLabel("daily", "2026-12-30", "prev"), "前一日 · 12月30日");
  assert.equal(neighbourLabel("daily", "2027-01-01", "next"), "后一日 · 2027年1月1日");
  mock.timers.setTime(new Date("2027-01-01T00:30:00+08:00").getTime());
  assert.equal(neighbourLabel("daily", "2026-12-31", "prev"), "前一日 · 2026年12月31日");
  assert.equal(neighbourLabel("daily", "2027-01-02", "next"), "后一日 · 1月2日");
});

test("the page calendar date changes year at Beijing midnight", () => {
  const lastHalfHour = Date.parse("2026-12-31T23:30:00+08:00");
  const firstHalfHour = Date.parse("2027-01-01T00:30:00+08:00");
  assert.equal(new Date(firstHalfHour).getUTCFullYear(), 2026);
  assert.equal(format.monthDay("2026-12-31", lastHalfHour), "12月31日");
  assert.equal(format.monthDay("2027-01-01", lastHalfHour), "2027年1月1日");
  assert.equal(format.monthDay("2026-12-31", firstHalfHour), "2026年12月31日");
  assert.equal(format.monthDay("2027-01-01", firstHalfHour), "1月1日");
});
