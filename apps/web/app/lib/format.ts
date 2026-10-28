import { beijingDate, beijingTime, beijingWeekday, isValidDate, monthDay } from "@aihot/contracts/time";

/** A list cut into runs of the same Beijing day, in the list's own order. */
export function byBeijingDay<T>(list: readonly T[], at: (entry: T) => string): Array<{ day: string; entries: T[] }> {
  const days: Array<{ day: string; entries: T[] }> = [];
  for (const entry of list) {
    const day = beijingDate(at(entry));
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

/** "周六" of a calendar date (YYYY-MM-DD). */
export function weekdayShort(date: string): string {
  return beijingWeekday(date).replace("星期", "周");
}

export function relativeTime(iso: string, now = Date.now()): string {
  if (isValidDate(iso)) return iso;
  const t = Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return beijingDate(iso);
}

export function fullDateTime(iso: string): string {
  if (isValidDate(iso)) return iso;
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days. */
export function monthDayTime(iso: string): string {
  if (isValidDate(iso)) return monthDay(iso);
  return `${monthDay(beijingDate(iso))} ${beijingTime(iso)}`;
}

export function publicationValue(at: string, precision?: string | null): string {
  return precision && isValidDate(precision) ? precision : at;
}

export function timelineValue(item: { timelineAt: string; publishedAt: string | null; publicationTime?: string | null }): string {
  return item.publishedAt && Date.parse(item.timelineAt) === Date.parse(item.publishedAt)
    ? publicationValue(item.timelineAt, item.publicationTime)
    : item.timelineAt;
}

export function clockTime(value: string): string {
  return isValidDate(value) ? monthDay(value) : beijingTime(value);
}

export function sourceInitial(name: string): string {
  const s = name.replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
