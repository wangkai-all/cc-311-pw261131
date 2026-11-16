/**
 * Time-zone aware calendar helpers.
 *
 * Rules used when a local wall clock time is ambiguous or nonexistent:
 * - nonexistent (spring forward): resolve with the offset in effect immediately
 *   after the gap, i.e. the clock time is shifted forward.
 * - ambiguous (fall back): resolve with the earlier UTC instant (the DST offset).
 * Both cases are surfaced as warnings in the aligned day so they are not silent.
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(tsUtc: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(tsUtc));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function localDateStr(tsUtc: number, timeZone: string): string {
  const p = localParts(tsUtc, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function localTimeStr(tsUtc: number, timeZone: string): string {
  const p = localParts(tsUtc, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function localStamp(tsUtc: number, timeZone: string): string {
  return `${localDateStr(tsUtc, timeZone)} ${localTimeStr(tsUtc, timeZone)}`;
}

/** Offset of local time from UTC in minutes (positive east of Greenwich). */
export function offsetMinutes(tsUtc: number, timeZone: string): number {
  const p = localParts(tsUtc, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - tsUtc) / 60000);
}

export function offsetLabel(tsUtc: number, timeZone: string): string {
  const off = offsetMinutes(tsUtc, timeZone);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function localWallToUtc(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const matches = (ts: number): boolean =>
    localDateStr(ts, timeZone) === date && localTimeStr(ts, timeZone) === `${pad2(hh)}:${pad2(mm)}`;
  // Iterate until the local wall clock round-trips; each step is exact for a
  // fixed offset, so this converges in at most two passes.
  let ts = guess - offsetMinutes(guess, timeZone) * 60000;
  if (matches(ts)) return ts;
  const second = guess - offsetMinutes(ts, timeZone) * 60000;
  if (matches(second)) return second;
  // Nonexistent local time (spring forward). The first correction used the
  // offset in force at the naive instant, i.e. before the gap, so the result is
  // shifted forward across the gap — the documented resolution rule.
  return ts;
}

export interface DayBounds {
  date: string;
  startUtc: number;
  endUtc: number;
  minutes: number;
  intervals: number;
  dstTransition: boolean;
  startOffsetMinutes: number;
  endOffsetMinutes: number;
}

export function dayBoundsUtc(date: string, timeZone: string, intervalMinutes = 15): DayBounds {
  const startUtc = localWallToUtc(date, '00:00', timeZone);
  const endUtc = localWallToUtc(addDays(date, 1), '00:00', timeZone);
  const minutes = Math.round((endUtc - startUtc) / 60000);
  return {
    date,
    startUtc,
    endUtc,
    minutes,
    intervals: Math.round(minutes / intervalMinutes),
    dstTransition: minutes !== 1440,
    startOffsetMinutes: offsetMinutes(startUtc + 60000, timeZone),
    endOffsetMinutes: offsetMinutes(endUtc - 60000, timeZone),
  };
}

export function parseDateStr(date: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDateStr(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function diffDays(a: string, b: string): number {
  const pa = parseDateStr(a);
  const pb = parseDateStr(b);
  return Math.round(
    (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000,
  );
}

export function weekday(date: string): number {
  const { y, m, d } = parseDateStr(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekendDate(date: string): boolean {
  const w = weekday(date);
  return w === 0 || w === 6;
}

export function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function formatUtc(ts: number): string {
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

export function formatLocalWithOffset(ts: number, timeZone: string): string {
  return `${localDateStr(ts, timeZone)} ${localTimeStr(ts, timeZone)} (${offsetLabel(ts, timeZone)})`;
}

export function parseTimeToMinutes(t: string): number {
  const [hh, mm] = t.split(':').map(Number);
  return hh * 60 + mm;
}

export function minutesToTime(mins: number): string {
  const norm = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(norm / 60))}:${pad2(norm % 60)}`;
}

/** Number of whole interval starts inside [startUtc, endUtc). */
export function countIntervalStarts(startUtc: number, endUtc: number, intervalMinutes: number): number {
  if (endUtc <= startUtc) return 0;
  return Math.ceil((endUtc - startUtc) / (intervalMinutes * 60000));
}

export function slotKeyFor(tsUtc: number, timeZone: string): string {
  return localTimeStr(tsUtc, timeZone);
}

export const slotKeyOf = slotKeyFor;

/** True if the event window crosses a UTC-offset change inside the site's local day. */
export function windowCrossesDst(startUtc: number, endUtc: number, timeZone: string): boolean {
  return offsetMinutes(startUtc, timeZone) !== offsetMinutes(endUtc, timeZone);
}
