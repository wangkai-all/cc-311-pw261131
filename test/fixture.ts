/**
 * Small synthetic dataset builder for tests.
 *
 * Everything is constructed in memory with an explicit, legible model so a
 * test can state the truth: `load = base + slope * (temp - 60)` plus a known
 * curtailment inside a known event window. No randomness.
 */

import type {
  DatasetVersion,
  DrEvent,
  EventRevision,
  Holiday,
  Meter,
  ProductionRecord,
  RawRead,
  Site,
  Station,
  WeatherObs,
} from '../src/types.js';
import { enumerateDates, localWallToUtc } from '../src/time.js';

export interface FixtureOptions {
  startDate: string;
  endDate: string;
  siteId?: string;
  timezone?: string;
  baseKw?: number;
  slopeKwPerF?: number;
  /** Local wall-clock window of the dispatch. */
  eventDate?: string;
  eventStart?: string;
  eventEnd?: string;
  /** Fraction of load removed inside the dispatch window (0.15 = 15% shed). */
  curtail?: number;
  /** Whether to emit reads during the event window. */
  emitEventReads?: boolean;
}

export interface Fixture {
  dataset: DatasetVersion;
  site: Site;
  eventId: string;
  /** Counterfactual (no-dispatch) kWh per interval, keyed by UTC ms. */
  truth: Map<number, number>;
}

const TZ_OFFSET_CACHE = new Map<string, number>();

function offsetAt(ts: number, tz: string): number {
  const key = `${tz}:${Math.floor(ts / 86400000)}`;
  const cached = TZ_OFFSET_CACHE.get(key);
  if (cached !== undefined) return cached;
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  const off = Math.round((asUtc - ts) / 60000);
  TZ_OFFSET_CACHE.set(key, off);
  return off;
}

export function buildFixture(opts: FixtureOptions): Fixture {
  const siteId = opts.siteId ?? 'SITE-T';
  const tz = opts.timezone ?? 'America/Chicago';
  const baseKw = opts.baseKw ?? 400;
  const slope = opts.slopeKwPerF ?? 8;
  const eventDate = opts.eventDate ?? '2026-08-18';
  const eventStart = opts.eventStart ?? '15:00';
  const eventEnd = opts.eventEnd ?? '18:00';
  const curtail = opts.curtail ?? 0.15;

  const site: Site = {
    id: siteId,
    name: 'Test Plant',
    timezone: tz,
    segment: 'Test',
    floorAreaSqft: 100000,
    latitude: 41.9,
    longitude: -87.6,
    weatherStationId: 'WX-T',
    note: '',
  };
  const station: Station = { id: 'WX-T', name: 'Test Station', city: 'Test', note: '' };
  const meter: Meter = { id: 'M-1', siteId, serial: 'S1', multiplier: 1, installedAtUtc: 0, removedAtUtc: null, note: '' };

  const dates = enumerateDates(opts.startDate, opts.endDate);
  // Temperature: seasonal-ish ramp + diurnal shape, deterministic and
  // independent of the dispatch (the dispatch is a load effect only).
  const tempFor = (date: string, hour: number): number => {
    const doy = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse('2026-01-01T00:00:00Z')) / 86400000);
    const season = Math.cos((2 * Math.PI * (doy - 15)) / 365);
    const diurnal = -Math.cos((2 * Math.PI * ((hour - 3 + 24) % 24)) / 24);
    const dayIdx = doy - Math.floor((Date.parse(`${opts.startDate}T00:00:00Z`) - Date.parse('2026-01-01T00:00:00Z')) / 86400000);
    return 46 - 20 * season + 9 * diurnal + ((dayIdx * 7) % 5) - 2;
  };

  const weather: WeatherObs[] = [];
  for (const date of dates) {
    for (let h = 0; h < 24; h++) {
      const ts = localWallToUtc(date, `${String(h).padStart(2, '0')}:00`, tz);
      weather.push({ stationId: 'WX-T', tsUtc: ts, tempF: tempFor(date, h), humidityPct: 50, rowRef: `weather:${date}:${h}` });
    }
  }

  const eventStartUtc = localWallToUtc(eventDate, eventStart, tz);
  const eventEndUtc = localWallToUtc(eventDate, eventEnd, tz);

  const reads: RawRead[] = [];
  const truth = new Map<number, number>();
  for (const date of dates) {
    for (let slot = 0; slot < 96; slot++) {
      const hh = Math.floor(slot / 4);
      const mm = (slot % 4) * 15;
      const ts = localWallToUtc(date, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz);
      const temp = tempFor(date, hh + mm / 60);
      // Deterministic measurement/behaviour noise (~2.5% of load). Without it a
      // noiseless fixture produces a zero-width bootstrap interval, which would
      // hide an uncertainty bug rather than test one.
      const noise = ((Math.sin(ts / 900000) * 43758.5453) % 1) * 2.5;
      const weatherKw = slope * Math.max(0, temp - 60) + 12 * Math.max(0, 55 - temp);
      const counterfactualKw = (baseKw + weatherKw) * (1 + noise / 100);
      truth.set(ts, counterfactualKw / 4);
      const inWindow = ts >= eventStartUtc && ts < eventEndUtc;
      if (inWindow && opts.emitEventReads === false) continue;
      const kw = inWindow ? counterfactualKw * (1 - curtail) : counterfactualKw;
      reads.push({ siteId, meterId: meter.id, tsUtc: ts, kwh: Math.round((kw / 4) * 1000) / 1000, quality: 'measured', rowRef: `read:${date}:${slot}` });
    }
  }

  const revision: EventRevision = {
    id: 'EV-T-r1',
    eventId: 'EV-T',
    revision: 1,
    status: 'completed',
    siteIds: [siteId],
    localDate: eventDate,
    localStart: eventStart,
    localEnd: eventEnd,
    timeBasis: 'site_local',
    startUtc: eventStartUtc,
    endUtc: eventEndUtc,
    siteWindows: [{ siteId, startUtc: eventStartUtc, endUtc: eventEndUtc }],
    issuedAtUtc: eventStartUtc - 86400000,
    note: 'test dispatch',
    changes: ['initial'],
    supersedesRevisionId: null,
    cancellationAtUtc: null,
    cancellationReason: null,
    cancelledByRevisionId: null,
  };
  const event: DrEvent = {
    id: 'EV-T',
    name: 'Test Dispatch',
    program: 'Test',
    currentRevisionId: revision.id,
    currentScheduledRevisionId: revision.id,
    revisions: [revision],
  };

  const holidays: Holiday[] = [];
  const production: ProductionRecord[] = [];

  const dataset: DatasetVersion = {
    id: 'ds-fixture',
    label: 'fixture',
    createdAtUtc: '2026-09-01T00:00:00Z',
    sourceLabel: 'fixture',
    notes: [],
    analysisStartDate: opts.startDate,
    analysisEndDate: opts.endDate,
    sites: [site],
    stations: [station],
    meters: [meter],
    reads,
    weather,
    production,
    holidays,
    events: [event],
    quarantine: [],
    ingest: {
      files: [],
      rawRows: reads.length + weather.length,
      acceptedReads: reads.length,
      acceptedWeather: weather.length,
      quarantined: 0,
      byCode: {},
      duplicatesDropped: 0,
      outOfPeriodReads: 0,
      outOfPeriodWeather: 0,
      warnings: [],
      asOfLabel: 'fixture',
    },
    rawHash: 'fixture-hash',
  };

  return { dataset, site, eventId: 'EV-T', truth };
}
