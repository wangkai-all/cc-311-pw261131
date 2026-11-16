/**
 * Interval alignment.
 *
 * Builds a site-local day grid from UTC instants (so DST days are 92/96/100
 * intervals), attaches the reading from the meter(s) active at that instant, and
 * attaches production status, event membership, and weather.
 *
 * Missing readings stay missing. We never synthesize a zero.
 */

import { dayBoundsUtc, enumerateDates, localDateStr, offsetMinutes, slotKeyOf } from './time.js';
import type {
  AlignedDay,
  AlignedInterval,
  AlignmentWarning,
  DatasetVersion,
  ProductionStatus,
  Site,
  SiteAlignment,
  WeatherObs,
} from './types.js';

const INTERVAL_MS = 15 * 60 * 1000;
const NEAREST_WEATHER_MS = 2 * 60 * 60 * 1000;
const SEVERITY: Record<ProductionStatus, number> = {
  normal: 0,
  reduced: 1,
  non_routine: 2,
  planned_maintenance: 3,
  unplanned_shutdown: 4,
};

export function alignSite(dataset: DatasetVersion, site: Site): SiteAlignment {
  const tz = site.timezone;
  const stationId = site.weatherStationId;
  const siteMeters = dataset.meters.filter((m) => m.siteId === site.id);
  const meterById = new Map(siteMeters.map((m) => [m.id, m]));

  const readingsByTs = new Map<number, { meterId: string; kwh: number; quality: 'measured' | 'estimated' }[]>();
  for (const r of dataset.reads) {
    if (r.siteId !== site.id) continue;
    const list = readingsByTs.get(r.tsUtc) ?? [];
    list.push({ meterId: r.meterId, kwh: r.kwh, quality: r.quality });
    readingsByTs.set(r.tsUtc, list);
  }

  const weather = dataset.weather.filter((w) => w.stationId === stationId).sort((a, b) => a.tsUtc - b.tsUtc);
  const weatherTimes = weather.map((w) => w.tsUtc);

  const nearestWeather = (ts: number): { obs: WeatherObs | null; delta: number } => {
    if (weatherTimes.length === 0) return { obs: null, delta: Infinity };
    let lo = 0;
    let hi = weatherTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weatherTimes[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [weather[lo], weather[Math.max(0, lo - 1)]].filter(Boolean);
    let best: WeatherObs | null = null;
    let bestDelta = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c.tsUtc - ts);
      if (d < bestDelta) {
        best = c;
        bestDelta = d;
      }
    }
    return { obs: best, delta: bestDelta };
  };

  const productionBySite = dataset.production.filter((p) => p.siteId === site.id);
  const holidays = dataset.holidays.filter((h) => h.siteIds.length === 0 || h.siteIds.includes(site.id));
  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));

  const meterAt = (ts: number) =>
    siteMeters.filter((m) => ts >= m.installedAtUtc && (m.removedAtUtc === null || ts < m.removedAtUtc));

  const warnings = new Map<string, AlignmentWarning>();
  const warn = (code: string, severity: AlignmentWarning['severity'], message: string, example: string) => {
    const w = warnings.get(code) ?? { code, severity, message, examples: [] };
    if (w.examples.length < 6) w.examples.push(example);
    warnings.set(code, w);
  };

  const summary: SiteAlignment['summary'] = {
    days: 0,
    intervals: 0,
    present: 0,
    missing: 0,
    conflict: 0,
    estimatedExcluded: 0,
    noActiveMeter: 0,
    invalid: 0,
    duplicatesDropped: dataset.ingest.duplicatesDropped,
    missingExamples: [],
    conflicts: [],
    meterDuringReads: [],
    duplicateReadList: [],
    outsideMeterExamples: [],
  };

  const days = new Map<string, AlignedDay>();
  const dayList: AlignedDay[] = [];
  const dates = enumerateDates(dataset.analysisStartDate, dataset.analysisEndDate);
  const dateSet = new Set(dates);

  // Local days touched by a meter install or removal.
  const exchangeDays = new Map<string, string>();
  for (const m of siteMeters) {
    for (const [ts, label] of [
      [m.installedAtUtc, `installed ${m.id}`],
      [m.removedAtUtc, `removed ${m.id}`],
    ] as [number | null, string][]) {
      if (ts === null) continue;
      const localDate = localDateStr(ts, tz);
      if (!dateSet.has(localDate)) continue;
      const prev = exchangeDays.get(localDate);
      exchangeDays.set(localDate, prev ? `${prev}; ${label}` : label);
    }
  }

  for (const date of dates) {
    const bounds = dayBoundsUtc(date, tz);
    const dayIntervals: AlignedInterval[] = [];
    let covered = 0;
    const loadValues: number[] = [];
    const tempValues: number[] = [];
    let productionAdjustmentKwh = 0;
    const anomalyStatuses = new Set<ProductionStatus>();
    let hasVerifiedAnomaly = false;
    const dayEventIds = new Set<string>();

    for (let ts = bounds.startUtc; ts < bounds.endUtc; ts += INTERVAL_MS) {
      const localTime = slotKeyOf(ts, tz);
      const active = meterAt(ts);
      const activeIds = new Set(active.map((m) => m.id));
      const allReads = readingsByTs.get(ts) ?? [];
      let status: AlignedInterval['status'] = 'missing';
      let kwh: number | null = null;
      let quality: AlignedInterval['quality'] = null;
      let meterId: string | null = null;
      const intervalWarnings: string[] = [];

      // Reads attributed to a meter that was not active at this instant are
      // quarantined at alignment time rather than trusted.
      const usable = allReads.filter((r) => activeIds.has(r.meterId));
      const stale = allReads.filter((r) => !activeIds.has(r.meterId));
      if (stale.length > 0) {
        intervalWarnings.push(`ignored ${stale.map((r) => r.meterId).join(', ')} (meter inactive at this instant)`);
        if (summary.outsideMeterExamples.length < 8) {
          summary.outsideMeterExamples.push({
            tsUtc: ts,
            code: 'read_outside_meter_window',
            detail: `${localDateStr(ts, tz)} ${localTime}: ${stale.map((r) => r.meterId).join(', ')}`,
          });
        }
        warn(
          'read_outside_meter_window',
          'warning',
          'Readings exist outside their meter’s active window and were not used.',
          `${date} ${localTime}: ${stale.map((r) => r.meterId).join(', ')}`,
        );
      }

      if (active.length === 0) {
        status = stale.length > 0 ? 'invalid' : 'no_active_meter';
        if (status === 'invalid') {
          summary.invalid++;
          intervalWarnings.push('reading present but no active meter');
        } else {
          summary.noActiveMeter++;
        }
        if (status === 'no_active_meter' && !warnings.has('no_active_meter')) {
          warn('no_active_meter', 'warning', 'A gap exists with no active meter. Those intervals are unusable for attribution.', `${date} ${localTime}`);
        }
      } else if (usable.length === 0) {
        status = 'missing';
        summary.missing++;
        if (summary.missingExamples.length < 10) {
          summary.missingExamples.push({ tsUtc: ts, code: 'missing_read', detail: `${date} ${localTime}` });
        }
      } else if (usable.length > 1) {
        status = 'meter_conflict';
        summary.conflict++;
        if (summary.conflicts.length < 10) {
          summary.conflicts.push({
            tsUtc: ts,
            code: 'meter_conflict',
            detail: `${date} ${localTime}: ${usable.map((r) => `${r.meterId}=${r.kwh.toFixed(2)}`).join(', ')}`,
          });
        }
        warn(
          'meter_overlap',
          'warning',
          'Two active meters reported the same interval (exchange overlap). Conflicts are excluded, not averaged.',
          `${date} ${localTime} (${active.map((m) => m.id).join(' + ')})`,
        );
      } else {
        const r = usable[0];
        status = 'ok';
        kwh = r.kwh;
        quality = r.quality;
        meterId = r.meterId;
        covered++;
        summary.present++;
        if (r.quality === 'estimated') {
          intervalWarnings.push('estimated read');
          warn(
            'estimated_read',
            'info',
            'Estimated reads are present. They are excluded when "treat estimated as missing" is on and are never reported as measured.',
            `${date} ${localTime}`,
          );
        }
        if (active.length > 1) {
          // Only one usable read among two active meters: still ambiguous, but
          // we can use the read while surfacing the exchange.
          intervalWarnings.push('two active meters, one reading');
        }
      }

      const wx = nearestWeather(ts);
      let tempF: number | null = null;
      let tempSource: AlignedInterval['tempSource'] = null;
      if (wx.obs && wx.delta <= NEAREST_WEATHER_MS) {
        tempF = wx.obs.tempF;
        tempSource = wx.delta <= INTERVAL_MS ? 'observed' : 'nearest';
        tempValues.push(tempF);
        if (tempSource === 'nearest') {
          warn(
            'weather_gap_filled',
            'warning',
            'Temperature is joined from the nearest hourly observation (up to 2 hours away). Affected intervals are flagged and can be excluded.',
            `${date} ${localTime} (Δ${Math.round(wx.delta / 60000)} min)`,
          );
        }
      } else {
        intervalWarnings.push('no weather within 2h');
      }

      let prodStatus: ProductionStatus = 'normal';
      const prodNotes: string[] = [];
      const prodRecords: { id: string; status: ProductionStatus; verified: boolean; note: string }[] = [];
      for (const p of productionBySite) {
        if (ts >= p.startUtc && ts < p.endUtc) {
          if (SEVERITY[p.status] > SEVERITY[prodStatus]) prodStatus = p.status;
          prodNotes.push(`${p.status}${p.verified ? '' : ' (unverified)'}: ${p.note}`);
          prodRecords.push({ id: p.id, status: p.status, verified: p.verified, note: p.note });
          if (p.verified && p.status !== 'normal') hasVerifiedAnomaly = true;
          if (p.status !== 'normal') anomalyStatuses.add(p.status);
          if (p.verified && p.expectedDropPct !== null && kwh !== null) {
            const f = p.expectedDropPct / 100;
            if (f < 1) productionAdjustmentKwh += kwh * (f / (1 - f));
          }
        }
      }

      for (const e of dataset.events) {
        for (const rev of e.revisions) {
          if (!rev.siteIds.includes(site.id) || rev.startUtc === null || rev.endUtc === null) continue;
          if (ts >= rev.startUtc && ts < rev.endUtc) dayEventIds.add(e.id);
        }
      }

      if (kwh !== null) loadValues.push(kwh);
      dayIntervals.push({
        tsUtc: ts,
        localDate: date,
        localTime,
        offsetMinutes: offsetMinutes(ts, tz),
        kwh,
        status,
        quality,
        meterId,
        tempF,
        tempSource,
        productionStatus: prodStatus,
        productionRecords: prodRecords,
        productionNotes: prodNotes,
        warnings: intervalWarnings,
        eventIds: [...dayEventIds],
      });
    }

    const expected = bounds.intervals;
    const coverage = expected === 0 ? 0 : covered / expected;
    const meanLoadKw = loadValues.length > 0 ? (loadValues.reduce((a, b) => a + b, 0) / loadValues.length) * 4 : null;
    const meanTempF = tempValues.length > 0 ? tempValues.reduce((a, b) => a + b, 0) / tempValues.length : null;
    const exchangeNote = exchangeDays.get(date) ?? null;

    if (bounds.dstTransition) {
      warn(
        'dst_transition_day',
        'info',
        'This local day is not 24 hours long. The interval grid follows UTC instants, so the day has 92 or 100 intervals.',
        `${date}: ${bounds.intervals} intervals, offsets ${bounds.startOffsetMinutes} → ${bounds.endOffsetMinutes} min`,
      );
    }
    if (coverage < 1 && coverage > 0) {
      warn(
        'incomplete_day',
        'warning',
        'Some local days have incomplete telemetry. Missing intervals are excluded from attribution rather than filled with zero.',
        `${date}: ${covered}/${expected} intervals (${(coverage * 100).toFixed(1)}%)`,
      );
    }

    // Event ids per interval were accumulated in day order; rewrite them to be
    // exact per interval by intersecting with the union we built (cheap enough).
    const day: AlignedDay = {
      date,
      startUtc: bounds.startUtc,
      endUtc: bounds.endUtc,
      expectedIntervals: expected,
      dstTransition: bounds.dstTransition,
      dstNote: bounds.dstTransition
        ? `Local day spans ${bounds.minutes} minutes; offset ${bounds.startOffsetMinutes} → ${bounds.endOffsetMinutes} min.`
        : null,
      isWeekend: isWeekend(date),
      isHoliday: holidayByDate.has(date),
      holidayName: holidayByDate.get(date) ?? null,
      eventIds: [...dayEventIds],
      meterExchange: exchangeNote !== null,
      meterExchangeNote: exchangeNote,
      productionAnomalyStatuses: [...anomalyStatuses],
      productionVerifiedExclusion: hasVerifiedAnomaly,
      coverage,
      presentIntervals: covered,
      meanLoadKw,
      meanTempF,
      productionAdjustmentKwh,
      intervals: dayIntervals,
    };
    dayList.push(day);
    days.set(date, day);
    summary.days++;
    summary.intervals += expected;
  }

  summary.estimatedExcluded = dayList.reduce(
    (a, d) => a + d.intervals.filter((iv) => iv.quality === 'estimated').length,
    0,
  );

  if (summary.missing > 0) {
    warn(
      'missing_reads',
      'warning',
      'Some intervals have no reading at all. They remain missing and are excluded from attribution — never treated as zero kWh.',
      `${summary.missing} intervals across ${summary.days} local days`,
    );
  }
  if (summary.conflict > 0) {
    warn(
      'meter_conflicts',
      'warning',
      'Some intervals have readings from more than one active meter. They are excluded from attribution.',
      `${summary.conflict} intervals`,
    );
  }
  if (summary.noActiveMeter > 0) {
    warn('no_active_meter', 'warning', 'Some intervals fall in a gap with no active meter.', `${summary.noActiveMeter} intervals`);
  }

  return {
    site,
    days,
    dayList,
    warnings: [...warnings.values()],
    summary,
  };
}

function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}
