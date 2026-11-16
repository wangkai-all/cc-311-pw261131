/**
 * CSV ingest and dataset version assembly.
 *
 * Design rules:
 * - Bad rows are quarantined with a code and a reason, never silently zeroed.
 * - Duplicate (site, interval) readings are kept as conflicts for alignment.
 * - All temporal fields are normalized to UTC at ingest; local labels used for
 *   grouping are derived from the site timezone, never parsed from text.
 * - A corrections file produces a new immutable dataset version.
 */

import { createHash } from 'node:crypto';
import { parseCsv, toObjects } from './csv.js';
import { dayBoundsUtc, localDateStr, localStamp, localWallToUtc } from './time.js';
import { diffDays } from './time.js';
import { sha256, stableStringify } from './util.js';
import type {
  DatasetVersion,
  DrEvent,
  EventRevision,
  Holiday,
  IngestFileInfo,
  IngestSummary,
  Meter,
  ProductionRecord,
  ProductionStatus,
  QuarantineRow,
  RawRead,
  Site,
  Station,
  VersionDiff,
  WeatherObs,
} from './types.js';

export interface SourceFile {
  name: string;
  kind: string;
  content: string;
  sha256?: string;
}

export interface BuildOptions {
  id: string;
  label: string;
  createdAtUtc: string;
  sourceLabel: string;
  notes: string[];
  analysisStartDate: string;
  analysisEndDate: string;
  asOfLabel: string;
}

const MAX_KWH_PER_INTERVAL = 3000; // 12 MW for a 15-minute interval: implausible for these sites
const MAX_TEMP_F = 130;
const MIN_TEMP_F = -80;
const PRODUCTION_STATUSES: ProductionStatus[] = ['normal', 'planned_maintenance', 'unplanned_shutdown', 'reduced', 'non_routine'];

class Quarantine {
  rows: QuarantineRow[] = [];
  byCode: Record<string, number> = {};
  add(rowRef: string, code: string, detail: string, raw = ''): void {
    this.rows.push({ rowRef, code, detail, raw: raw.slice(0, 300) });
    this.byCode[code] = (this.byCode[code] ?? 0) + 1;
  }
}

interface RawWeather extends WeatherObs {
  stationId: string;
}

interface ProductionUpsert {
  kind: 'production';
  siteId: string;
  startUtc: number;
  field: string;
  newValue: string;
}

interface ReadUpsert {
  kind: 'read';
  siteId: string;
  tsUtc: number;
  kwh: number;
  quality: 'measured' | 'estimated';
}

function parseUtc(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  // Strict UTC ISO check; reject local timestamps that lack a zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?Z$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '0'] = m;
  const ms = Number(frac.padEnd(3, '0'));
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (!Number.isFinite(ts)) return null;
  // Round-trip check catches e.g. 2026-02-31.
  const back = new Date(ts).toISOString().replace('.000Z', 'Z');
  const normalized = `${y}-${mo}-${d}T${h}:${mi}:${s.padStart(2, '0')}Z`;
  if (back !== normalized) {
    const withoutSeconds = `${y}-${mo}-${d}T${h}:${mi}:00Z`;
    if (back !== withoutSeconds) return null;
  }
  return ts;
}

function num(v: string): number | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface BuildResult {
  dataset: DatasetVersion;
  versionDiff: VersionDiff | null;
}


/** Build a dataset version from a set of source files. */
export function buildDataset(files: SourceFile[], base: DatasetVersion | null, opts: BuildOptions): BuildResult {
  const q = new Quarantine();
  const fileInfos: IngestFileInfo[] = [];
  const byKind = new Map<string, SourceFile>();
  for (const f of files) {
    byKind.set(f.kind, f);
    fileInfos.push({
      name: f.name,
      kind: f.kind,
      bytes: Buffer.byteLength(f.content, 'utf8'),
      rows: Math.max(0, f.content.trim().split('\n').length - 1),
      sha256: f.sha256 ?? sha256(f.content),
    });
  }

  const required = ['sites', 'stations', 'reads', 'weather', 'production', 'meters', 'events', 'holidays'];
  for (const kind of required) {
    if (!byKind.has(kind)) {
      throw new Error(`missing required file for kind "${kind}"`);
    }
  }

  let rawRows = 0;
  const rowsOf = (kind: string) => {
    const f = byKind.get(kind);
    if (!f) return [];
    const parsed = parseCsv(f.content);
    for (const e of parsed.errors) q.add(`${f.name}:${e.line}`, 'csv_malformed', e.message, e.raw);
    rawRows += parsed.rows.length;
    return toObjects(parsed).map((o) => ({ ...o, file: f.name }));
  };

  // ---- sites ----
  const sites: Site[] = [];
  for (const { row, line, file } of rowsOf('sites') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    const site: Site = {
      id: row.site_id?.trim(),
      name: row.name?.trim(),
      timezone: row.timezone?.trim(),
      segment: row.segment?.trim(),
      floorAreaSqft: num(row.floor_area_sqft) ?? 0,
      latitude: num(row.latitude) ?? 0,
      longitude: num(row.longitude) ?? 0,
      weatherStationId: row.weather_station_id?.trim(),
      note: row.note ?? '',
    };
    if (!site.id || !site.name || !site.timezone) {
      q.add(`${file}:${line}`, 'site_invalid', 'missing site_id/name/timezone', row.site_id);
      continue;
    }
    try {
      localDateStr(Date.now(), site.timezone);
    } catch {
      q.add(`${file}:${line}`, 'site_invalid', `unknown timezone "${site.timezone}"`, site.id);
      continue;
    }
    if (sites.some((s) => s.id === site.id)) {
      q.add(`${file}:${line}`, 'site_duplicate', `duplicate site id ${site.id}`, site.id);
      continue;
    }
    sites.push(site);
  }
  if (sites.length === 0) throw new Error('no valid sites in sites.csv');

  // ---- stations ----
  const stations: Station[] = [];
  for (const { row, line, file } of rowsOf('stations') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    if (!row.station_id) {
      q.add(`${file}:${line}`, 'station_invalid', 'missing station_id', '');
      continue;
    }
    stations.push({
      id: row.station_id.trim(),
      name: row.name?.trim() ?? row.station_id.trim(),
      city: row.city?.trim() ?? '',
      note: row.note ?? '',
    });
  }

  // ---- meters ----
  const meters: Meter[] = [];
  for (const { row, line, file } of rowsOf('meters') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    const installedAtUtc = parseUtc(row.installed_utc ?? '');
    const removedAtUtc = row.removed_utc ? parseUtc(row.removed_utc) : null;
    const multiplier = num(row.multiplier) ?? 1;
    if (!row.meter_id || !row.site_id || installedAtUtc === null) {
      q.add(`${file}:${line}`, 'meter_invalid', 'missing meter_id/site_id or unparseable installed_utc', row.meter_id ?? '');
      continue;
    }
    if (row.removed_utc && removedAtUtc === null) {
      q.add(`${file}:${line}`, 'meter_invalid', 'unparseable removed_utc', row.meter_id);
      continue;
    }
    if (removedAtUtc !== null && removedAtUtc <= installedAtUtc) {
      q.add(`${file}:${line}`, 'meter_invalid', 'removed_utc is not after installed_utc', row.meter_id);
      continue;
    }
    if (!(multiplier > 0)) {
      q.add(`${file}:${line}`, 'meter_invalid', 'multiplier must be positive', row.meter_id);
      continue;
    }
    meters.push({
      id: row.meter_id.trim(),
      siteId: row.site_id.trim(),
      serial: row.serial ?? '',
      installedAtUtc,
      removedAtUtc,
      multiplier,
      note: row.note ?? '',
    });
  }
  const meterById = new Map(meters.map((m) => [m.id, m]));
  const siteById = new Map(sites.map((s) => [s.id, s]));

  // ---- weather ----
  const periodStartUtc = Date.parse(`${opts.analysisStartDate}T00:00:00Z`);
  const periodEndUtc = Date.parse(`${opts.analysisEndDate}T23:59:59Z`);
  const weather: WeatherObs[] = [];
  const weatherKeys = new Set<string>();
  let outOfPeriodWeather = 0;
  const stationIds = new Set(stations.map((s) => s.id));
  for (const { row, line, file } of rowsOf('weather') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    const tsUtc = parseUtc(row.obs_ts_utc ?? '');
    const tempF = num(row.temp_f);
    const humidityPct = num(row.humidity_pct);
    const rowRef = `${row.station_id ?? '?'}:${row.obs_ts_utc ?? '?'}`;
    if (!row.station_id || !stationIds.has(row.station_id)) {
      q.add(rowRef, 'weather_unknown_station', `station ${row.station_id ?? ''} not in stations.csv`, `${file}:${line}`);
      continue;
    }
    if (tsUtc === null) {
      q.add(rowRef, 'weather_bad_timestamp', 'obs_ts_utc is not strict ISO-8601 UTC', `${file}:${line}`);
      continue;
    }
    if (tempF === null || tempF > MAX_TEMP_F || tempF < MIN_TEMP_F) {
      q.add(rowRef, 'weather_bad_value', `temp_f ${row.temp_f ?? ''} out of plausible range`, `${file}:${line}`);
      continue;
    }
    if (humidityPct !== null && (humidityPct < 0 || humidityPct > 100)) {
      q.add(rowRef, 'weather_bad_humidity', `humidity ${row.humidity_pct} out of range; humidity set to null`, `${file}:${line}`);
    }
    if (tsUtc < periodStartUtc - 86400000 || tsUtc > periodEndUtc + 86400000) {
      outOfPeriodWeather++;
      continue;
    }
    const key = `${row.station_id}:${tsUtc}`;
    if (weatherKeys.has(key)) {
      q.add(rowRef, 'weather_duplicate', 'duplicate station/timestamp; later row ignored', `${file}:${line}`);
      continue;
    }
    weatherKeys.add(key);
    weather.push({
      stationId: row.station_id,
      tsUtc,
      tempF,
      humidityPct: humidityPct !== null && humidityPct >= 0 && humidityPct <= 100 ? humidityPct : null,
      rowRef,
    });
  }
  weather.sort((a, b) => a.tsUtc - b.tsUtc);

  // ---- production ----
  const production: ProductionRecord[] = [];
  const prodRows = rowsOf('production') as Array<{ row: Record<string, string>; line: number; file: string }>;
  for (const { row, line, file } of prodRows) {
    const startUtc = parseUtc(row.start_utc ?? '');
    const endUtc = parseUtc(row.end_utc ?? '');
    const status = (row.status ?? '').trim() as ProductionStatus;
    const verifiedRaw = (row.verified ?? '').trim().toLowerCase();
    const verified = verifiedRaw === 'true' || verifiedRaw === 'yes' || verifiedRaw === '1';
    const expectedDropPct = num(row.expected_drop_pct);
    if (!row.site_id || !siteById.has(row.site_id)) {
      q.add(`${file}:${line}`, 'production_unknown_site', `site ${row.site_id ?? ''} not in sites.csv`, `${file}:${line}`);
      continue;
    }
    if (startUtc === null || endUtc === null || endUtc <= startUtc) {
      q.add(`${file}:${line}`, 'production_bad_window', 'start_utc/end_utc missing, non-UTC, or end<=start', `${file}:${line}`);
      continue;
    }
    if (!PRODUCTION_STATUSES.includes(status)) {
      q.add(`${file}:${line}`, 'production_bad_status', `unknown status "${status}"`, `${file}:${line}`);
      continue;
    }
    if (expectedDropPct !== null && (expectedDropPct < 0 || expectedDropPct > 100)) {
      q.add(`${file}:${line}`, 'production_bad_drop', `expected_drop_pct ${row.expected_drop_pct} out of range`, `${file}:${line}`);
      continue;
    }
    production.push({
      id: `PROD-${production.length + 1}`,
      siteId: row.site_id,
      startUtc,
      endUtc,
      status,
      verified,
      expectedDropPct,
      source: row.source ?? '',
      note: row.note ?? '',
    });
  }

  // ---- holidays ----
  const holidays: Holiday[] = [];
  for (const { row, line, file } of rowsOf('holidays') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    const date = (row.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      q.add(`${file}:${line}`, 'holiday_bad_date', 'date must be YYYY-MM-DD', date);
      continue;
    }
    const siteIds = (row.site_ids ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = siteIds.filter((s) => !siteById.has(s));
    if (unknown.length > 0) {
      q.add(`${file}:${line}`, 'holiday_unknown_site', `unknown site ids: ${unknown.join(', ')}`, date);
      continue;
    }
    holidays.push({ date, name: row.name ?? 'Holiday', siteIds });
  }

  // ---- events ----
  interface RevAccum {
    eventId: string;
    name: string;
    program: string;
    revisions: Map<number, Omit<EventRevision, 'id' | 'eventId'>>;
  }
  const eventAccum = new Map<string, RevAccum>();
  for (const { row, line, file } of rowsOf('events') as Array<{ row: Record<string, string>; line: number; file: string }>) {
    const eventId = (row.event_id ?? '').trim();
    const siteIds = (row.site_ids ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const revision = num(row.revision);
    const timeBasis = (row.time_basis ?? 'site_local') as 'utc' | 'site_local';
    const status = (row.status ?? '') as EventRevision['status'];
    const issuedAtUtc = parseUtc(row.issued_utc ?? '');
    const localDate = (row.local_date ?? '').trim() || null;
    const localStart = (row.local_start ?? '').trim() || null;
    const localEnd = (row.local_end ?? '').trim() || null;
    const startUtcText = (row.start_utc ?? '').trim();
    const endUtcText = (row.end_utc ?? '').trim();
    const rowRef = `${file}:${line}`;

    if (!eventId || revision === null) {
      q.add(rowRef, 'event_invalid', 'missing event_id or revision', eventId);
      continue;
    }
    if (!['scheduled', 'active', 'completed', 'cancelled'].includes(status)) {
      q.add(rowRef, 'event_bad_status', `unknown status "${status}"`, eventId);
      continue;
    }
    if (issuedAtUtc === null) {
      q.add(rowRef, 'event_bad_issued', 'issued_utc is not strict ISO-8601 UTC', eventId);
      continue;
    }
    if (siteIds.length === 0 || siteIds.some((s) => !siteById.has(s))) {
      q.add(rowRef, 'event_unknown_site', `event site list invalid: ${siteIds.join(';')}`, eventId);
      continue;
    }
    let startUtc: number | null = null;
    let endUtc: number | null = null;
    const siteWindows: { siteId: string; startUtc: number; endUtc: number }[] = [];
    let windowError: string | null = null;
    for (const siteId of siteIds) {
      const tz = siteById.get(siteId)!.timezone;
      let s: number | null = null;
      let e: number | null = null;
      if (timeBasis === 'utc') {
        s = parseUtc(startUtcText);
        e = parseUtc(endUtcText);
      } else {
        if (!localDate || !localStart || !localEnd) {
          windowError = 'site_local event is missing local_date/local_start/local_end';
          s = null;
          break;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}$/.test(localStart) || !/^\d{2}:\d{2}$/.test(localEnd)) {
          windowError = 'local_date/local_start/local_end malformed';
          s = null;
          break;
        }
        s = localWallToUtc(localDate, localStart, tz);
        e = localWallToUtc(localDate, localEnd, tz);
      }
      if (s === null || e === null) {
        windowError ??= 'could not resolve event window to UTC';
        break;
      }
      if (e <= s) {
        windowError ??= 'event end is not after start (or crosses midnight without a date split)';
        break;
      }
      siteWindows.push({ siteId, startUtc: s, endUtc: e });
      if (startUtc === null) {
        startUtc = s;
        endUtc = e;
      }
    }
    if (windowError) {
      // One quarantine row per bad event row, not one per site in its list.
      q.add(rowRef, 'event_bad_window', windowError, eventId);
      continue;
    }
    if (startUtc === null || endUtc === null) continue;
    const cancellationAtUtc = row.cancellation_utc ? parseUtc(row.cancellation_utc) : null;
    if (row.cancellation_utc && cancellationAtUtc === null) {
      q.add(rowRef, 'event_bad_cancel', 'cancellation_utc is not strict ISO-8601 UTC', eventId);
      continue;
    }
    if (status === 'cancelled' && cancellationAtUtc === null) {
      q.add(rowRef, 'event_bad_cancel', 'cancelled revision has no cancellation_utc', eventId);
      continue;
    }
    let acc = eventAccum.get(eventId);
    if (!acc) {
      acc = { eventId, name: row.name ?? eventId, program: row.program ?? '', revisions: new Map() };
      eventAccum.set(eventId, acc);
    }
    if (acc.revisions.has(revision)) {
      q.add(rowRef, 'event_duplicate_revision', `duplicate revision ${revision} for ${eventId}; later row ignored`, eventId);
      continue;
    }
    acc.revisions.set(revision, {
      revision,
      status,
      siteIds,
      localDate,
      localStart,
      localEnd,
      timeBasis,
      startUtc,
      endUtc,
      siteWindows,
      issuedAtUtc,
      note: row.note ?? '',
      changes: (row.changes ?? '').split(';').map((s) => s.trim()).filter(Boolean),
      supersedesRevisionId: null,
      cancellationAtUtc,
      cancellationReason: (row.cancellation_reason ?? '').trim() || null,
      cancelledByRevisionId: null,
    });
  }

  const events: DrEvent[] = [];
  for (const acc of eventAccum.values()) {
    const revs = [...acc.revisions.values()].sort((a, b) => a.revision - b.revision);
    const mapped: EventRevision[] = revs.map((r) => ({
      ...r,
      id: `${acc.eventId}:R${r.revision}`,
      eventId: acc.eventId,
      supersedesRevisionId: r.revision > 1 ? `${acc.eventId}:R${r.revision - 1}` : null,
    }));
    // Cancellations by a later revision mark earlier revisions as cancelled.
    for (let i = 0; i < mapped.length; i++) {
      const later = mapped.slice(i + 1).find((r) => r.status === 'cancelled');
      if (later) {
        mapped[i].status = 'cancelled';
        mapped[i].cancelledByRevisionId = later.id;
        if (!mapped[i].cancellationAtUtc) mapped[i].cancellationAtUtc = later.cancellationAtUtc;
        if (!mapped[i].cancellationReason) mapped[i].cancellationReason = later.cancellationReason;
      }
    }
    const latest = mapped[mapped.length - 1];
    const latestScheduled = [...mapped].reverse().find((r) => r.status !== 'cancelled');
    events.push({
      id: acc.eventId,
      name: acc.name,
      program: acc.program,
      currentRevisionId: latest.id,
      currentScheduledRevisionId: latestScheduled ? latestScheduled.id : null,
      revisions: mapped,
    });
  }
  events.sort((a, b) => {
    const ar = a.revisions[a.revisions.length - 1];
    const br = b.revisions[b.revisions.length - 1];
    return (ar.startUtc ?? 0) - (br.startUtc ?? 0) || a.id.localeCompare(b.id);
  });

  // ---- corrections (v2+) ----
  const corrections = byKind.get('corrections');
  const readUpserts: ReadUpsert[] = [];
  const prodUpserts: ProductionUpsert[] = [];
  if (corrections) {
    const parsed = parseCsv(corrections.content);
    for (const e of parsed.errors) q.add(`${corrections.name}:${e.line}`, 'csv_malformed', e.message, e.raw);
    for (const { row, line } of toObjects(parsed)) {
      const rowRef = `${corrections.name}:${line}`;
      if ((row.kind ?? '').trim() === 'read') {
        const tsUtc = parseUtc(row.read_ts_utc ?? '');
        const kwh = num(row.kwh);
        if (!row.site_id || tsUtc === null || kwh === null || kwh < 0) {
          q.add(rowRef, 'correction_invalid', 'read correction needs site_id, strict UTC timestamp, and kwh>=0', '');
          continue;
        }
        readUpserts.push({
          kind: 'read',
          siteId: row.site_id,
          tsUtc,
          kwh,
          quality: row.quality === 'estimated' ? 'estimated' : 'measured',
        });
      } else if ((row.kind ?? '').trim() === 'production') {
        const startUtc = parseUtc(row.start_utc ?? '');
        if (!row.site_id || startUtc === null || !row.field) {
          q.add(rowRef, 'correction_invalid', 'production correction needs site_id, start_utc, field', '');
          continue;
        }
        prodUpserts.push({ kind: 'production', siteId: row.site_id, startUtc, field: row.field, newValue: row.new_value ?? '' });
      } else {
        q.add(rowRef, 'correction_invalid', `unknown correction kind "${row.kind}"`, '');
      }
    }
  }

  // Apply production corrections to this version's copy.
  const productionChanges: VersionDiff['productionChanges'] = [];
  for (const up of prodUpserts) {
    const target = production.find((p) => p.siteId === up.siteId && p.startUtc === up.startUtc);
    if (!target) {
      q.add(`correction:${up.siteId}`, 'correction_target_missing', 'production correction did not match any record', up.siteId);
      continue;
    }
    let oldValue = '';
    if (up.field === 'verified') {
      oldValue = String(target.verified);
      target.verified = up.newValue.trim().toLowerCase() === 'true';
    } else if (up.field === 'expected_drop_pct') {
      oldValue = String(target.expectedDropPct ?? '');
      const v = num(up.newValue);
      if (v === null || v < 0 || v > 100) {
        q.add(`correction:${up.siteId}`, 'correction_invalid', 'expected_drop_pct must be 0-100', up.newValue);
        continue;
      }
      target.expectedDropPct = v;
    } else if (up.field === 'status') {
      oldValue = target.status;
      if (!PRODUCTION_STATUSES.includes(up.newValue as ProductionStatus)) {
        q.add(`correction:${up.siteId}`, 'correction_invalid', `unknown status ${up.newValue}`, up.newValue);
        continue;
      }
      target.status = up.newValue as ProductionStatus;
    } else {
      q.add(`correction:${up.siteId}`, 'correction_invalid', `unsupported production field ${up.field}`, up.field);
      continue;
    }
    if (oldValue !== up.newValue) {
      productionChanges.push({ siteId: up.siteId, startUtc: up.startUtc, field: up.field, oldValue, newValue: up.newValue });
    }
  }

  // ---- reads ----
  const reads: RawRead[] = [];
  const readSeen = new Map<string, RawRead>();
  let duplicatesDropped = 0;
  let outOfPeriodReads = 0;
  let correctedReads = 0;
  const readRows = rowsOf('reads') as Array<{ row: Record<string, string>; line: number; file: string }>;
  for (const { row, line, file } of readRows) {
    const tsUtc = parseUtc(row.read_ts_utc ?? '');
    const kwh = num(row.kwh);
    const rowRef = (row.row_ref ?? `${file}:${line}`).trim();
    const siteId = (row.site_id ?? '').trim();
    const meterId = (row.meter_id ?? '').trim();
    const quality = row.quality === 'estimated' ? 'estimated' : 'measured';
    if (!siteId || !siteById.has(siteId)) {
      q.add(rowRef, 'read_unknown_site', `site "${siteId}" not in sites.csv`, row.read_ts_utc ?? '');
      continue;
    }
    if (tsUtc === null) {
      q.add(rowRef, 'read_bad_timestamp', 'read_ts_utc is not strict ISO-8601 UTC (missing Z or wrong shape)', row.read_ts_utc ?? '');
      continue;
    }
    if (kwh === null) {
      q.add(rowRef, 'read_bad_value', 'kwh is not numeric', row.kwh ?? '');
      continue;
    }
    if (kwh < 0) {
      q.add(rowRef, 'read_negative', `negative kwh ${kwh}`, row.kwh ?? '');
      continue;
    }
    if (kwh > MAX_KWH_PER_INTERVAL) {
      q.add(rowRef, 'read_absurd', `kwh ${kwh} exceeds plausible per-interval maximum ${MAX_KWH_PER_INTERVAL}`, row.kwh ?? '');
      continue;
    }
    const meter = meterById.get(meterId);
    if (!meter) {
      q.add(rowRef, 'read_unknown_meter', `meter "${meterId}" not in meter_registry.csv`, meterId);
      continue;
    }
    if (meter.siteId !== siteId) {
      q.add(rowRef, 'read_meter_site_mismatch', `meter ${meterId} belongs to ${meter.siteId}, row says ${siteId}`, rowRef);
      continue;
    }
    if (tsUtc < periodStartUtc || tsUtc > periodEndUtc) {
      outOfPeriodReads++;
      continue;
    }
    const dupKey = `${siteId}:${tsUtc}:${meterId}`;
    const existing = readSeen.get(dupKey);
    if (existing) {
      duplicatesDropped++;
      q.add(
        rowRef,
        'read_duplicate',
        `duplicate reading for ${siteId} at ${new Date(tsUtc).toISOString()} on ${meterId}; kept first (${existing.kwh} kWh), dropped ${kwh} kWh`,
        rowRef,
      );
      continue;
    }
    const read: RawRead = { siteId, meterId, tsUtc, kwh: kwh * meter.multiplier, quality, rowRef };
    readSeen.set(dupKey, read);
    reads.push(read);
  }

  // Apply read corrections (overwrite same site/interval, any meter).
  for (const up of readUpserts) {
    const meter = meters.find((m) => m.siteId === up.siteId && up.tsUtc >= m.installedAtUtc && (m.removedAtUtc === null || up.tsUtc < m.removedAtUtc));
    if (!meter) {
      q.add(`correction:${up.siteId}`, 'correction_target_missing', 'read correction has no active meter at that time', up.siteId);
      continue;
    }
    const existingIdx = reads.findIndex((r) => r.siteId === up.siteId && r.tsUtc === up.tsUtc);
    if (existingIdx >= 0) {
      const old = reads[existingIdx];
      if (Math.abs(old.kwh - up.kwh) > 0.001 || old.quality !== up.quality) correctedReads++;
      reads[existingIdx] = { ...old, kwh: up.kwh, quality: up.quality, rowRef: `correction:${up.siteId}:${up.tsUtc}` };
    } else {
      reads.push({
        siteId: up.siteId,
        meterId: meter.id,
        tsUtc: up.tsUtc,
        kwh: up.kwh,
        quality: up.quality,
        rowRef: `correction:${up.siteId}:${up.tsUtc}`,
      });
    }
  }

  reads.sort((a, b) => a.tsUtc - b.tsUtc || a.siteId.localeCompare(b.siteId));

  // ---- assemble ----
  const rawHash = sha256(
    stableStringify({
      files: fileInfos.map((f) => [f.name, f.sha256]),
      readCount: reads.length,
      weatherCount: weather.length,
      productionCount: production.length,
      events: events.length,
    }),
  );

  const ingestWarnings: string[] = [];
  if (duplicatesDropped > 0) ingestWarnings.push(`${duplicatesDropped} duplicate readings dropped (first value kept, later value quarantined).`);
  if (outOfPeriodReads > 0) ingestWarnings.push(`${outOfPeriodReads} readings fell outside the analysis period and were not loaded.`);
  if (outOfPeriodWeather > 0) ingestWarnings.push(`${outOfPeriodWeather} weather observations fell outside the analysis period and were not loaded.`);

  const ingest: IngestSummary = {
    files: fileInfos,
    rawRows,
    acceptedReads: reads.length,
    acceptedWeather: weather.length,
    quarantined: q.rows.length,
    byCode: q.byCode,
    duplicatesDropped,
    outOfPeriodReads,
    outOfPeriodWeather,
    warnings: ingestWarnings,
    asOfLabel: opts.asOfLabel,
  };

  const dataset: DatasetVersion = {
    id: opts.id,
    label: opts.label,
    createdAtUtc: opts.createdAtUtc,
    sourceLabel: opts.sourceLabel,
    notes: opts.notes,
    analysisStartDate: opts.analysisStartDate,
    analysisEndDate: opts.analysisEndDate,
    sites,
    stations,
    meters,
    reads,
    weather,
    production,
    holidays,
    events,
    quarantine: q.rows,
    ingest,
    rawHash,
  };

  let versionDiff: VersionDiff | null = null;
  if (base) {
    const prodChanges = productionChanges.map((c) => {
      const prev = base.production.find((p) => p.siteId === c.siteId && p.startUtc === c.startUtc);
      let oldValue = c.oldValue;
      if (prev) {
        if (c.field === 'verified') oldValue = String(prev.verified);
        else if (c.field === 'expected_drop_pct') oldValue = String(prev.expectedDropPct ?? '');
        else if (c.field === 'status') oldValue = prev.status;
      }
      return { ...c, oldValue };
    });
    // Key on site + instant + meter: during an exchange two meters can both
    // report the same instant, and those are distinct observations.
    const readKey = (r: { siteId: string; tsUtc: number; meterId: string }) => `${r.siteId}:${r.tsUtc}:${r.meterId}`;
    const baseKeys = new Map(base.reads.map((r) => [readKey(r), r]));
    const newKeys = new Set(reads.map(readKey));
    let addedReads = 0;
    let modifiedReads = 0;
    const curByKey = new Map(reads.map((r) => [readKey(r), r]));
    for (const key of newKeys) if (!baseKeys.has(key)) addedReads++;
    for (const [key, prev] of baseKeys) {
      const cur = curByKey.get(key);
      if (!cur) continue;
      if (Math.abs(cur.kwh - prev.kwh) > 0.001 || cur.quality !== prev.quality) modifiedReads++;
    }
    const removedReads = [...baseKeys.keys()].filter((k) => !newKeys.has(k)).length;
    versionDiff = {
      fromVersionId: base.id,
      addedReads,
      correctedReads: modifiedReads,
      productionChanges: prodChanges,
      notes: [
        `${addedReads} interval readings added`,
        `${modifiedReads} interval readings corrected`,
        removedReads > 0 ? `${removedReads} readings no longer present` : '',
        `${prodChanges.length} production record fields changed`,
      ].filter(Boolean),
    };
    dataset.notes = [...dataset.notes, ...versionDiff.notes];
  }

  void correctedReads;
  return { dataset, versionDiff };
}

/** Count expected intervals for a site in a date range (DST-aware). */
export function expectedIntervalsForRange(startDate: string, endDate: string, timeZone: string): number {
  let total = 0;
  let d = startDate;
  while (d <= endDate) {
    total += dayBoundsUtc(d, timeZone).intervals;
    const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    if (next === d) break;
    d = next;
  }
  return total;
}

export { diffDays, localStamp };
