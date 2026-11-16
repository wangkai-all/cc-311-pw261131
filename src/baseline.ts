/**
 * Baseline rules and savings attribution.
 *
 * All rules receive *candidate* days that have already passed business-logic
 * filters (coverage, holidays, production anomalies, meter exchange). Each rule
 * applies its own sample-composition rules on top and reports the sample it
 * actually used.
 *
 * Leakage guard: candidate days must end before the analysis cutoff, which is
 * strictly before the event start (and before the event was issued). The event
 * day and any later day can never enter training.
 */

import { addDays, dayBoundsUtc, diffDays, localDateStr, isWeekendDate } from './time.js';
import { crewBlocks, hashOf, makeRng, median, quantile, round, seedFromString, sum } from './util.js';
import type {
  AlignedDay,
  Check,
  DayExclusion,
  ExclusionConfig,
  MethodId,
  MethodResult,
  MethodSeriesPoint,
  ProductionStatus,
  ReportInterval,
  SiteAlignment,
  TrainingSample,
} from './types.js';

export const METHOD_LABELS: Record<MethodId, string> = {
  matched_10of10_weather: 'Matched days (up to 10) + weather correction',
  matched_4of5_weather: 'Matched days (4 closest of 5 most recent) + weather correction',
  weather_regression: 'Per-slot weather regression',
};

export const METHOD_DESCRIPTIONS: Record<MethodId, string> = {
  matched_10of10_weather:
    'Same weekend/holiday class as the event day, mean temperature within tolerance, up to 10 candidates nearest the event date. Per-slot mean, plus an additive temperature correction when a supportable slope exists.',
  matched_4of5_weather:
    'The five most recent eligible days before the event; take the four with the closest mean temperature. Per-slot mean, plus an additive temperature correction when a supportable slope exists.',
  weather_regression:
    'Ordinary least squares per 15-minute slot over all eligible training days, with temperature as the only regressor. Used as a cross-check and when matched samples are thin.',
};

export const METHOD_IDS: MethodId[] = ['matched_10of10_weather', 'matched_4of5_weather', 'weather_regression'];

export const DEFAULT_EXCLUSIONS: ExclusionConfig = {
  minDayCoverage: 0.95,
  minActualCoverage: 0.75,
  minAttributableShare: 0.75,
  dailyCommit: true,
  excludeProductionStatuses: ['planned_maintenance', 'unplanned_shutdown', 'reduced'],
  excludeUnverifiedProduction: false,
  excludeHolidays: true,
  excludeEventDays: true,
  excludeDstTransitionDays: false,
  excludeMeterExchangeDays: true,
  treatEstimatedAsMissing: true,
  maxWeatherSlopeKwhPerF: 2.5,
  requireTemperatureOverlap: true,
  temperatureOverlapMarginF: 5,
  lookbackDays: 42,
  matchedDayCount: 10,
  recentPoolSize: 5,
  minMatchedDays: 4,
  matchTempToleranceF: 4,
  minMatchTempToleranceF: 2.5,
  regressionMinDays: 12,
  minSlotSampleRatio: 0.6,
  weatherCorrection: true,
  bootstrapReplicates: 600,
  bootstrapUnit: 'day',
  confidenceLevel: 0.9,
  autoPolicy: 'min_uncertainty',
  methodOverride: null,
};

export interface EventWindow {
  startUtc: number;
  endUtc: number;
}

export interface CandidateDay {
  date: string;
  day: AlignedDay;
  /** Mean temperature over the same clock hours as the event window. */
  meanTempF: number | null;
  loadKwh: number;
  intervalKwh: Array<number | null>;
}

export interface BaselineContext {
  alignment: SiteAlignment;
  window: EventWindow;
  eventDate: string;
  eventLocalDates: string[];
  cutoffUtc: number;
  cutoffDate: string;
  exclusions: ExclusionConfig;
  timezone: string;
  /** Local clock slots covered by the event window (e.g. 16:00 … 18:45). */
  windowSlots: string[];
}

const PRODUCTION_LABEL: Record<ProductionStatus, string> = {
  normal: 'normal',
  planned_maintenance: 'planned maintenance',
  unplanned_shutdown: 'unplanned shutdown',
  reduced: 'reduced output',
  non_routine: 'non-routine operation',
};

export function productionStatusLabel(s: ProductionStatus): string {
  return PRODUCTION_LABEL[s];
}

export interface CandidateSet {
  candidates: CandidateDay[];
  examined: DayExclusion[];
  excluded: DayExclusion[];
  excludedByReason: Record<string, number>;
  unverifiedAnomalyDays: number;
}

/**
 * Classify every day before the cutoff into candidate / excluded, recording the
 * business reasons. Shared across rules so their samples remain comparable and
 * the UI can explain why a day was dropped.
 */
export function buildCandidates(ctx: BaselineContext): CandidateSet {
  const cfg = ctx.exclusions;
  const evStartDate = ctx.eventLocalDates[0] ?? ctx.eventDate;
  const windowStartDate = addDays(evStartDate, -cfg.lookbackDays);
  const examined: DayExclusion[] = [];
  const excluded: DayExclusion[] = [];
  const excludedByReason: Record<string, number> = {};
  const candidates: CandidateDay[] = [];
  let unverifiedAnomalyDays = 0;

  const windowSlots = new Set(ctx.windowSlots);

  for (const day of ctx.alignment.dayList) {
    // Never look at the event day or later; the window starts inside it.
    if (day.date >= evStartDate) break;
    if (day.endUtc > ctx.window.startUtc) break;
    if (day.date < windowStartDate) continue;
    const reasons: string[] = [];

    const excludedProductions = day.intervals
      .map((iv) => iv.productionStatus)
      .filter((s) => s !== 'normal' && cfg.excludeProductionStatuses.includes(s));
    if (excludedProductions.length > 0) {
      reasons.push(`production_${[...new Set(excludedProductions)].join('_')}`);
    }
    const hasUnverified = day.intervals.some(
      (iv) => iv.productionStatus !== 'normal' && iv.productionNotes.some((n) => n.includes('unverified')),
    );
    if (hasUnverified) unverifiedAnomalyDays++;
    if (cfg.excludeUnverifiedProduction && hasUnverified) reasons.push('production_unverified');

    if (cfg.excludeHolidays && day.isHoliday) reasons.push('holiday');
    if (cfg.excludeEventDays && day.eventIds.length > 0) reasons.push('event_day');
    if (cfg.excludeDstTransitionDays && day.dstTransition) reasons.push('dst_transition');
    if (cfg.excludeMeterExchangeDays && day.meterExchange) reasons.push('meter_exchange');
    if (day.presentIntervals === 0) reasons.push('no_data');
    else if (day.coverage < cfg.minDayCoverage) reasons.push('low_coverage');
    if (day.meanTempF === null) reasons.push('no_weather');
    if (cfg.treatEstimatedAsMissing && day.intervals.some((iv) => iv.quality === 'estimated')) reasons.push('estimated_reads');

    const record: DayExclusion = { date: day.date, reasons, selectedMatched: false };
    examined.push(record);
    if (reasons.length > 0) {
      excluded.push(record);
      for (const r of reasons) excludedByReason[r] = (excludedByReason[r] ?? 0) + 1;
    } else {
      const windowTemps = day.intervals
        .filter((iv) => windowSlots.has(iv.localTime) && iv.tempF !== null)
        .map((iv) => iv.tempF as number);
      candidates.push({
        date: day.date,
        day,
        meanTempF:
          windowTemps.length > 0
            ? windowTemps.reduce((a, b) => a + b, 0) / windowTemps.length
            : day.meanTempF,
        loadKwh: sum(day.intervals.map((iv) => iv.kwh)),
        intervalKwh: day.intervals.map((iv) => iv.kwh),
      });
    }
  }
  return { candidates, examined, excluded, excludedByReason, unverifiedAnomalyDays };
}

export function eventMetrics(
  ctx: BaselineContext,
  reportIntervals: ReportInterval[],
): {
  windowIntervals: number;
  actualKwh: number;
  attributableIndices: number[];
  tempMean: number | null;
  tempRange: [number, number] | null;
} {
  const temps = reportIntervals.map((r) => r.tempF).filter((t): t is number => t !== null);
  const attributableIndices = reportIntervals
    .filter((r) => r.attributable && r.actualKwh !== null)
    .map((r) => r.index);
  const actualKwh = attributableIndices.reduce((a, i) => a + (reportIntervals[i].actualKwh ?? 0), 0);
  void ctx;
  return {
    windowIntervals: reportIntervals.length,
    actualKwh,
    attributableIndices,
    tempMean: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
    tempRange: temps.length ? [Math.min(...temps), Math.max(...temps)] : null,
  };
}

interface MatchedArgs {
  candidates: CandidateDay[];
  eventDate: string;
  eventTempMean: number | null;
  cfg: ExclusionConfig;
}

function selectMatchedDays(args: MatchedArgs, method: MethodId): { days: CandidateDay[]; tolerance: number; selectedBy: string } {
  const { candidates, eventDate, eventTempMean, cfg } = args;
  if (candidates.length === 0) return { days: [], tolerance: 0, selectedBy: 'no eligible days' };
  const eventWeekend = isWeekendDate(eventDate);
  const sameClass = candidates.filter((c) => isWeekendDate(c.date) === eventWeekend);
  const pool = sameClass.length > 0 ? sameClass : candidates;

  if (method === 'matched_4of5_weather') {
    const recent = [...pool].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, cfg.recentPoolSize);
    if (eventTempMean === null) return { days: recent.slice(0, 4), tolerance: 0, selectedBy: 'no event temperature; took 4 most recent' };
    const days = [...recent]
      .sort((a, b) => Math.abs((a.meanTempF ?? 0) - eventTempMean) - Math.abs((b.meanTempF ?? 0) - eventTempMean))
      .slice(0, Math.min(4, recent.length));
    const tol = Math.max(...days.map((d) => Math.abs((d.meanTempF ?? 0) - eventTempMean)));
    return { days, tolerance: tol, selectedBy: `4 closest of ${recent.length} most recent eligible days` };
  }

  const sortedByRecency = [...pool].sort((a, b) => (a.date < b.date ? 1 : -1));
  let tolerance = cfg.minMatchTempToleranceF;
  let picked: CandidateDay[] = [];
  while (tolerance <= cfg.matchTempToleranceF + 1e-9) {
    if (eventTempMean === null) {
      picked = sortedByRecency.slice(0, cfg.matchedDayCount);
    } else {
      picked = sortedByRecency
        .filter((c) => c.meanTempF !== null && Math.abs(c.meanTempF - eventTempMean) <= tolerance)
        .slice(0, cfg.matchedDayCount);
    }
    if (picked.length >= Math.min(cfg.minMatchedDays, cfg.matchedDayCount)) break;
    tolerance = Math.round((tolerance + 0.5) * 2) / 2;
  }
  const usedTol =
    eventTempMean === null || picked.length === 0
      ? 0
      : Math.round(Math.max(...picked.map((p) => Math.abs((p.meanTempF ?? 0) - eventTempMean))) * 100) / 100;
  return {
    days: picked,
    tolerance: usedTol,
    selectedBy:
      eventTempMean === null
        ? `${picked.length} most recent eligible days (no event temperature)`
        : `${picked.length} days within ${usedTol.toFixed(1)}°F of the event-day mean`,
  };
}

interface SlotStats {
  mean: number;
  n: number;
  meanTemp: number | null;
  temps: number;
}

function slotMeans(days: AlignedDay[]): {
  byKey: Map<string, SlotStats>;
  perSlotMinSamples: number;
  perSlotMinTempSamples: number;
} {
  const acc = new Map<string, { values: number[]; temps: number[] }>();
  for (const day of days) {
    for (const iv of day.intervals) {
      if (iv.kwh === null) continue;
      const rec = acc.get(iv.localTime) ?? { values: [], temps: [] };
      rec.values.push(iv.kwh);
      if (iv.tempF !== null) rec.temps.push(iv.tempF);
      acc.set(iv.localTime, rec);
    }
  }
  const byKey = new Map<string, SlotStats>();
  let minN = Infinity;
  let minT = Infinity;
  for (const [key, rec] of acc) {
    const mean = rec.values.reduce((a, b) => a + b, 0) / rec.values.length;
    const meanTemp = rec.temps.length ? rec.temps.reduce((a, b) => a + b, 0) / rec.temps.length : null;
    byKey.set(key, { mean, n: rec.values.length, meanTemp, temps: rec.temps.length });
    minN = Math.min(minN, rec.values.length);
    minT = Math.min(minT, rec.temps.length);
  }
  return {
    byKey,
    perSlotMinSamples: Number.isFinite(minN) ? minN : 0,
    perSlotMinTempSamples: Number.isFinite(minT) ? minT : 0,
  };
}

interface SlopeResult {
  slope: number | null;
  n: number;
  note: string;
  valid: boolean;
}

/** Day-level mean slope over the window's clock hours, converted to per-interval kWh/°F. */
function estimateSlope(days: AlignedDay[], firstLocalTime: string, lastLocalTime: string, cfg: ExclusionConfig): SlopeResult {
  const points: { temp: number; kwh: number }[] = [];
  for (const day of days) {
    const ivs = day.intervals.filter(
      (iv) => iv.kwh !== null && iv.tempF !== null && iv.localTime >= firstLocalTime && iv.localTime <= lastLocalTime,
    );
    if (ivs.length < 4) continue;
    points.push({
      temp: ivs.reduce((a, b) => a + (b.tempF ?? 0), 0) / ivs.length,
      kwh: ivs.reduce((a, b) => a + (b.kwh ?? 0), 0) / ivs.length,
    });
  }
  if (points.length < 6) {
    return { slope: null, n: points.length, note: `too few training days with both load and temperature (${points.length}); no correction applied`, valid: false };
  }
  const xs = points.map((p) => p.temp);
  const ys = points.map((p) => p.kwh);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const sd = Math.sqrt(sxx / xs.length);
  if (sxx === 0 || sd < 1.5) {
    return { slope: null, n: points.length, note: `training days lack temperature spread (SD ${sd.toFixed(2)}°F); correction not identifiable`, valid: false };
  }
  const slope = sxy / sxx;
  if (Math.abs(slope) > cfg.maxWeatherSlopeKwhPerF) {
    return {
      slope,
      n: points.length,
      note: `slope ${slope.toFixed(2)} kWh/°F per interval exceeds the plausibility limit ${cfg.maxWeatherSlopeKwhPerF}; correction rejected`,
      valid: false,
    };
  }
  return { slope, n: points.length, note: `slope ${slope.toFixed(2)} kWh/°F per interval from ${points.length} training days`, valid: true };
}

export interface BuiltMethod {
  result: MethodResult;
  baselineCi90: [number, number] | null;
  intervalBaselines: Map<number, number>;
  /** Bootstrap draws of the total window baseline (kWh), one array per replicate. */
  bootstrapTotals: number[];
  /** Bootstrap draws per attributable interval, aligned with attributableIndices. */
  bootstrapSlotDraws: number[][];
  attributableIndices: number[];
}

export interface MethodBuildOptions {
  ctx: BaselineContext;
  candidates: CandidateSet;
  method: MethodId;
  reportIntervals: ReportInterval[];
  seedKey: string;
}

export function buildMethod(opts: MethodBuildOptions): BuiltMethod {
  const { ctx, candidates, method, reportIntervals, seedKey } = opts;
  const cfg = ctx.exclusions;
  const checks: Check[] = [];
  const warningCodes: string[] = [];
  const baselineGapReasons: Record<string, number> = {};
  const ev = eventMetrics(ctx, reportIntervals);

  const windowStartDate = addDays(ctx.eventLocalDates[0] ?? ctx.eventDate, -cfg.lookbackDays);
  const trainingEndDate = ctx.cutoffDate;
  const candidateList = candidates.candidates;
  const firstLocal = reportIntervals[0]?.localTime ?? '00:00';
  const lastLocal = reportIntervals[reportIntervals.length - 1]?.localTime ?? '00:00';

  let matched: CandidateDay[] = [];
  let matchTolerance = 0;
  let selectedBy = '';
  let slope: SlopeResult = { slope: null, n: 0, note: 'weather correction disabled', valid: false };
  let regression:
    | { perSlot: Map<string, { a: number; b: number; n: number; r2: number | null }>; minSamples: number; minTempSamples: number; medianR2: number | null }
    | null = null;

  // ISO-style day-type matching: a weekday dispatch is compared with weekday
  // load shapes. Pooling Saturdays and Sundays into a weekday model makes the
  // weekday/weekend schedule effect look like a temperature effect (weekends
  // are both cooler here and much lighter), which flips the slope sign.
  const eventWeekend = isWeekendDate(ctx.eventDate);
  const sameClassCandidates = candidateList.filter((c) => isWeekendDate(c.date) === eventWeekend);
  const regressionPool = sameClassCandidates.length >= cfg.regressionMinDays ? sameClassCandidates : candidateList;
  const dayTypeRestricted = regressionPool !== candidateList;

  if (method === 'weather_regression') {
    const bySlot = new Map<string, { temps: number[]; kwhs: number[] }>();
    for (const c of regressionPool) {
      for (const iv of c.day.intervals) {
        if (iv.kwh === null) continue;
        const rec = bySlot.get(iv.localTime) ?? { temps: [], kwhs: [] };
        rec.kwhs.push(iv.kwh);
        if (iv.tempF !== null) rec.temps.push(iv.tempF);
        bySlot.set(iv.localTime, rec);
      }
    }
    const perSlot = new Map<string, { a: number; b: number; n: number; r2: number | null }>();
    let minSamples = Infinity;
    let minTempSamples = Infinity;
    const r2s: number[] = [];
    for (const [key, rec] of bySlot) {
      minSamples = Math.min(minSamples, rec.kwhs.length);
      minTempSamples = Math.min(minTempSamples, rec.temps.length);
      const n = Math.min(rec.temps.length, rec.kwhs.length);
      if (n < 3) continue;
      const xs = rec.temps.slice(0, n);
      const ys = rec.kwhs.slice(0, n);
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxx += (xs[i] - mx) ** 2;
        sxy += (xs[i] - mx) * (ys[i] - my);
        syy += (ys[i] - my) ** 2;
      }
      const b = sxx > 0 ? sxy / sxx : 0;
      const a = my - b * mx;
      const r2 = syy > 0 && sxx > 0 ? (sxy * sxy) / (sxx * syy) : null;
      perSlot.set(key, { a, b, n, r2 });
      if (r2 !== null && Number.isFinite(r2)) r2s.push(r2);
    }
    regression = {
      perSlot,
      minSamples: Number.isFinite(minSamples) ? minSamples : 0,
      minTempSamples: Number.isFinite(minTempSamples) ? minTempSamples : 0,
      medianR2: median(r2s),
    };
    matched = regressionPool;
    selectedBy = dayTypeRestricted
      ? `all ${regressionPool.length} eligible ${eventWeekend ? 'weekend' : 'weekday'} days`
      : `all ${regressionPool.length} eligible days (too few same day-type days to restrict)`;
    slope = { slope: null, n: 0, note: 'per-slot regression embeds temperature; no separate slope', valid: false };
  } else {
    const sel = selectMatchedDays({ candidates: candidateList, eventDate: ctx.eventDate, eventTempMean: ev.tempMean, cfg }, method);
    matched = sel.days;
    matchTolerance = sel.tolerance;
    selectedBy = sel.selectedBy;
    if (cfg.weatherCorrection) {
      // The weather slope is estimated from the full eligible history, not just
      // the handful of matched days: a 4-day matched sample cannot identify a
      // slope on its own. It is fitted on the same day type (weekday/weekend) as
      // the event so the weekly production schedule is not mistaken for a
      // weather response; the correction is applied slot-by-slot to this rule's
      // matched baseline and the fitting sample is reported separately.
      slope = estimateSlope(regressionPool.map((m) => m.day), firstLocal, lastLocal, cfg);
    }
  }

  const means = method === 'weather_regression' ? null : slotMeans(matched.map((m) => m.day));

  // ---- per-interval baselines ----
  const intervalBaselines = new Map<number, number>();
  let slopeAdjustmentTotal = 0;
  let slopeAdjustmentCount = 0;
  for (const r of reportIntervals) {
    if (method === 'weather_regression') {
      const fit = regression?.perSlot.get(r.localTime);
      if (!fit) {
        baselineGapReasons.no_slot_fit = (baselineGapReasons.no_slot_fit ?? 0) + 1;
        continue;
      }
      if (r.tempF === null) {
        baselineGapReasons.no_temperature = (baselineGapReasons.no_temperature ?? 0) + 1;
        continue;
      }
      const base = fit.a + fit.b * r.tempF;
      if (!Number.isFinite(base) || base <= 0) {
        baselineGapReasons.non_positive_baseline = (baselineGapReasons.non_positive_baseline ?? 0) + 1;
        continue;
      }
      intervalBaselines.set(r.index, base);
      continue;
    }
    const m = means?.byKey.get(r.localTime);
    if (!m) {
      baselineGapReasons.no_slot_sample = (baselineGapReasons.no_slot_sample ?? 0) + 1;
      continue;
    }
    const required = Math.max(2, Math.ceil(cfg.minSlotSampleRatio * Math.max(1, matched.length)));
    if (m.n < required) {
      baselineGapReasons.thin_slot_sample = (baselineGapReasons.thin_slot_sample ?? 0) + 1;
      continue;
    }
    let base = m.mean;
    if (slope.valid && slope.slope !== null && r.tempF !== null && m.meanTemp !== null) {
      const adj = slope.slope * (r.tempF - m.meanTemp);
      base += adj;
      slopeAdjustmentTotal += adj;
      slopeAdjustmentCount++;
    }
    if (base <= 0) {
      baselineGapReasons.non_positive_baseline = (baselineGapReasons.non_positive_baseline ?? 0) + 1;
      continue;
    }
    intervalBaselines.set(r.index, base);
  }

  const expected = reportIntervals.length;
  const baselineCoverage = expected === 0 ? 0 : intervalBaselines.size / expected;
  const attributable = ev.attributableIndices;
  const pairedIndices = attributable.filter((i) => intervalBaselines.has(i));
  const pairedCoverage = expected === 0 ? 0 : pairedIndices.length / expected;
  const baselineKwh = pairedIndices.length === 0 ? null : pairedIndices.reduce((a, i) => a + (intervalBaselines.get(i) ?? 0), 0);
  const actualPairedKwh = pairedIndices.reduce((a, i) => a + (reportIntervals[i].actualKwh ?? 0), 0);
  const savingsKwh = baselineKwh === null ? null : baselineKwh - actualPairedKwh;
  const savingsPct = savingsKwh === null || baselineKwh === null || baselineKwh <= 0 ? null : (savingsKwh / baselineKwh) * 100;

  const windowDropKwh =
    pairedIndices.length === 0
      ? null
      : pairedIndices.reduce(
          (a, i) => a + ((reportIntervals[i].baselineKwh !== null ? 0 : 0) + (intervalBaselines.get(i) ?? 0) - (reportIntervals[i].actualKwh ?? 0)),
          0,
        );
  void windowDropKwh;

  // ---- bootstrap ----
  const attributableDraws: number[][] = [];
  const bootstrapTotals: number[] = [];
  let savingsCi: [number, number] | null = null;
  let baselineCi: [number, number] | null = null;
  let uncertaintyPct: number | null = null;

  if (matched.length >= 2 && pairedIndices.length > 0) {
    const rng = makeRng(seedFromString(seedKey + ':' + method));
    const reps = cfg.bootstrapReplicates;
    const windowSlots = pairedIndices.map((i) => reportIntervals[i].localTime);
    // Resampling unit is the training day. Slots are matched by clock time, so
    // a training day from another calendar date still lines up with the window.
    const perDayValues = matched.map((m) =>
      windowSlots.map((slot) => {
        const iv = m.day.intervals.find((x) => x.localTime === slot);
        return iv && iv.kwh !== null ? iv.kwh : null;
      }),
    );
    const perDayTemps = matched.map((m) =>
      windowSlots.map((slot) => m.day.intervals.find((x) => x.localTime === slot)?.tempF ?? null),
    );
    const slotTempMeans = windowSlots.map((_, j) => {
      const temps = perDayTemps.map((row) => row[j]).filter((t): t is number => t !== null);
      return temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    });

    for (let b = 0; b < reps; b++) {
      const picks = Array.from({ length: matched.length }, () => Math.floor(rng() * matched.length));
      let total = 0;
      const drawForSlot: number[] = [];
      if (method === 'weather_regression') {
        // Resample days and refit each slot's line, so the interval reflects
        // the regression's own sampling variability.
        for (let j = 0; j < windowSlots.length; j++) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const pick of picks) {
            const t = perDayTemps[pick][j];
            const y = perDayValues[pick][j];
            if (t !== null && y !== null) {
              xs.push(t);
              ys.push(y);
            }
          }
          const r = reportIntervals[pairedIndices[j]];
          if (xs.length < 3 || r.tempF === null) {
            const fallback = intervalBaselines.get(pairedIndices[j]) ?? 0;
            drawForSlot.push(fallback);
            total += fallback;
            continue;
          }
          const n = xs.length;
          const mx = xs.reduce((a, v) => a + v, 0) / n;
          const my = ys.reduce((a, v) => a + v, 0) / n;
          let sxx = 0;
          let sxy = 0;
          for (let i = 0; i < n; i++) {
            sxx += (xs[i] - mx) ** 2;
            sxy += (xs[i] - mx) * (ys[i] - my);
          }
          const slopeB = sxx > 0 ? sxy / sxx : 0;
          const base = Math.max(0, my + slopeB * (r.tempF - mx));
          drawForSlot.push(base);
          total += base;
        }
      } else {
        const sums = new Array<number>(windowSlots.length).fill(0);
        const counts = new Array<number>(windowSlots.length).fill(0);
        for (const pick of picks) {
          const row = perDayValues[pick];
          for (let j = 0; j < row.length; j++) {
            const v = row[j];
            if (v !== null) {
              sums[j] += v;
              counts[j] += 1;
            }
          }
        }
        for (let j = 0; j < windowSlots.length; j++) {
          let base = counts[j] > 0 ? sums[j] / counts[j] : intervalBaselines.get(pairedIndices[j]) ?? 0;
          const r = reportIntervals[pairedIndices[j]];
          const tMean = slotTempMeans[j];
          if (slope.valid && slope.slope !== null && r.tempF !== null && tMean !== null) {
            // Apply the fitted slope around the resampled mean temperature.
            base += slope.slope * (r.tempF - tMean);
          }
          drawForSlot.push(base);
          total += base;
        }
      }
      attributableDraws.push(drawForSlot);
      bootstrapTotals.push(total);
    }
    const sortedTotals = [...bootstrapTotals].sort((a, b) => a - b);
    const alpha = 1 - cfg.confidenceLevel;
    const lo = quantile(sortedTotals, alpha / 2);
    const hi = quantile(sortedTotals, 1 - alpha / 2);
    if (lo !== null && hi !== null) {
      savingsCi = [lo - actualPairedKwh, hi - actualPairedKwh];
      baselineCi = [lo, hi];
      uncertaintyPct = baselineKwh && baselineKwh > 0 ? ((hi - lo) / 2 / baselineKwh) * 100 : null;
    }
  }

  // ---- series with per-slot CI ----
  const series: MethodSeriesPoint[] = reportIntervals.map((r) => {
    const base = intervalBaselines.get(r.index) ?? null;
    let ci: [number, number] | null = null;
    const j = pairedIndices.indexOf(r.index);
    if (base !== null && j >= 0 && attributableDraws.length > 0) {
      const draws = attributableDraws.map((d) => d[j]).sort((a, b) => a - b);
      const alpha = 1 - cfg.confidenceLevel;
      const lo = quantile(draws, alpha / 2);
      const hi = quantile(draws, 1 - alpha / 2);
      if (lo !== null && hi !== null) ci = [lo, hi];
    }
    return { tsUtc: r.tsUtc, baselineKwh: base, ci90: ci };
  });

  // ---- checks ----
  const requiredDays = method === 'weather_regression' ? cfg.regressionMinDays : cfg.minMatchedDays;
  const minSlotRequired = Math.max(2, Math.ceil(cfg.minSlotSampleRatio * Math.max(1, matched.length)));
  checks.push({
    code: 'sample_size',
    label: 'Sufficient training days',
    passed: matched.length >= requiredDays,
    detail: `${matched.length} training days; this rule requires ${requiredDays}.`,
  });
  checks.push({
    code: 'slot_depth',
    label: 'Per-slot sample depth',
    passed: method === 'weather_regression' ? (regression?.minTempSamples ?? 0) >= 3 : (means?.perSlotMinTempSamples ?? 0) >= minSlotRequired,
    detail:
      method === 'weather_regression'
        ? `Thinnest slot has ${regression?.minTempSamples ?? 0} paired load/temperature observations.`
        : `Thinnest slot has ${means?.perSlotMinTempSamples ?? 0} temperature observations; rule needs ${minSlotRequired}.`,
  });
  const tempRange: [number, number] | null = (() => {
    const temps = matched.flatMap((m) => m.day.intervals.map((iv) => iv.tempF)).filter((t): t is number => t !== null);
    return temps.length ? [Math.min(...temps), Math.max(...temps)] : null;
  })();
  let extrapolation = false;
  if (ev.tempRange && tempRange && cfg.requireTemperatureOverlap) {
    extrapolation = tempRange[0] > ev.tempRange[1] + cfg.temperatureOverlapMarginF || tempRange[1] < ev.tempRange[0] - cfg.temperatureOverlapMarginF;
  }
  checks.push({
    code: 'temperature_overlap',
    label: 'Event temperature inside training range',
    passed: !extrapolation,
    detail:
      tempRange && ev.tempRange
        ? `Training ${tempRange[0].toFixed(1)}–${tempRange[1].toFixed(1)}°F; event ${ev.tempRange[0].toFixed(1)}–${ev.tempRange[1].toFixed(1)}°F.`
        : 'Temperature range unavailable for one side.',
  });
  checks.push({
    code: 'no_leakage',
    label: 'Training ends before the event',
    passed: ctx.cutoffUtc <= ctx.window.startUtc,
    detail: `Training cutoff ${new Date(ctx.cutoffUtc).toISOString()}; window opens ${new Date(ctx.window.startUtc).toISOString()}.`,
  });
  checks.push({
    code: 'baseline_coverage',
    label: 'Baseline covers the window',
    passed: baselineCoverage >= 0.999,
    detail: `${(baselineCoverage * 100).toFixed(1)}% of window intervals have a baseline value.`,
  });
  checks.push({
    code: 'attribution_coverage',
    label: 'Attributable intervals',
    passed: ev.windowIntervals === 0 ? false : attributable.length / ev.windowIntervals >= cfg.minAttributableShare,
    detail: `${attributable.length}/${ev.windowIntervals} window intervals pass the exclusion rules.`,
  });
  const applicable = checks.filter((c) => c.code !== 'attribution_coverage').every((c) => c.passed);
  for (const c of checks) {
    if (!c.passed) warningCodes.push(`check_failed:${c.code}`);
  }
  if (cfg.weatherCorrection && method !== 'weather_regression') {
    if (slope.valid) warningCodes.push('weather_slope_applied');
    else if (slope.slope !== null) warningCodes.push('weather_slope_rejected');
    else warningCodes.push('weather_slope_unavailable');
  }
  if (extrapolation) warningCodes.push('temperature_extrapolation');
  if (method !== 'weather_regression' && matched.length && matchTolerance > cfg.matchTempToleranceF) warningCodes.push('loose_temperature_match');
  if (pairedIndices.length < attributable.length) warningCodes.push('baseline_gaps_in_window');
  if (candidates.unverifiedAnomalyDays > 0 && !cfg.excludeUnverifiedProduction) warningCodes.push('unverified_anomaly_in_history');

  // Simple Response Match (SRM): share of the matched days' window load whose
  // interval profiles fall within ±25% of the event window's actual profile.
  const srm = computeSrm(reportIntervals, matched.map((m) => m.day), pairedIndices);

  const windowActual = attributable.length === 0 ? null : attributable.reduce((a, i) => a + (reportIntervals[i].actualKwh ?? 0), 0);
  const observedDrop =
    baselineKwh === null || windowActual === null || attributable.length === 0 ? null : baselineKwh - attributable.reduce((a, i) => a + (intervalBaselines.get(i) ?? 0) - (reportIntervals[i].actualKwh ?? 0) - (intervalBaselines.get(i) ?? 0) + 0, 0);

  const sample: TrainingSample = {
    candidateDays: candidateList.length,
    matchedDays: matched.length,
    examinedDays: candidates.examined.length,
    excludedDays: candidates.excluded.length,
    excludedByReason: candidates.excludedByReason,
    excludedUnverifiedAnomalyDays: candidates.unverifiedAnomalyDays,
    matchedDates: matched.map((m) => m.date),
    excludedExamples: candidates.excluded.slice(0, 40),
    candidateExamples: candidateList.slice(0, 80).map((c) => ({
      date: c.date,
      reasons: [],
      selectedMatched: matched.some((m) => m.date === c.date),
    })),
    windowStartDate,
    windowEndDate: trainingEndDate,
    trainingEndUtc: ctx.cutoffUtc,
    eventStartUtc: ctx.window.startUtc,
    leakageGuard: `Training uses readings strictly before ${new Date(ctx.cutoffUtc).toISOString()}; the window opens ${new Date(ctx.window.startUtc).toISOString()}.`,
    perSlotMinSamples: method === 'weather_regression' ? (regression?.minSamples ?? 0) : (means?.perSlotMinSamples ?? 0),
    perSlotMinTempSamples: method === 'weather_regression' ? (regression?.minTempSamples ?? 0) : (means?.perSlotMinTempSamples ?? 0),
    medianR2: regression?.medianR2 ?? null,
    tempRangeF: tempRange,
    eventTempRangeF: ev.tempRange,
    matchTempToleranceF: cfg.matchTempToleranceF,
    matchToleranceUsedF: matchTolerance,
    observedMatchDeviationF: matched.length && ev.tempMean !== null ? matchTolerance : null,
    dayTypeRestricted,
    dayType: eventWeekend ? 'weekend' : 'weekday',
    slopeSampleDays: slope.n,
    slopeKwhPerF: slope.slope === null ? null : round(slope.slope, 3),
    slopeNote:
      method === 'weather_regression'
        ? slope.note
        : `${slope.note} (fitted on the eligible training history, applied to this rule's matched-day baseline).`,
    slopeIsValid: slope.valid,
    slopeAdjustmentKwh: slopeAdjustmentCount > 0 ? round(slopeAdjustmentTotal, 1) : null,
    weatherExtrapolation: extrapolation,
    selectedSummary: selectedBy,
  };

  const result: MethodResult = {
    method,
    label: METHOD_LABELS[method],
    description: METHOD_DESCRIPTIONS[method],
    applicable,
    checks,
    sample,
    baselineKwh: baselineKwh === null ? null : round(baselineKwh, 2),
    baselineCoverage,
    baselineGapReasons,
    actualKwh: windowActual === null ? null : round(windowActual, 2),
    coverage: {
      windowIntervals: ev.windowIntervals,
      paired: pairedIndices.length,
      attributable: attributable.length,
      pairedFraction: pairedCoverage,
    },
    coverageNote:
      pairedIndices.length === expected
        ? 'Baseline and actual both cover every window interval.'
        : `Savings use ${pairedIndices.length}/${expected} intervals; ${expected - pairedIndices.length} lack a baseline or an attributable reading.`,
    windowDropKwh: null,
    nonDrDropKwh: null,
    savingsKwh: savingsKwh === null ? null : round(savingsKwh, 2),
    savingsCi90: savingsCi === null ? null : [round(savingsCi[0], 1)!, round(savingsCi[1], 1)!],
    uncertaintyPct: uncertaintyPct === null ? null : round(uncertaintyPct, 2),
    savingsPct: savingsPct === null ? null : round(savingsPct, 2),
    srm,
    warningCodes,
    selected: false,
    selectionReason: '',
    deltaVsSelected: null,
    series,
  };
  void observedDrop;

  return {
    result,
    baselineCi90: baselineCi,
    intervalBaselines,
    bootstrapTotals,
    bootstrapSlotDraws: attributableDraws,
    attributableIndices: pairedIndices,
  };
}

function computeSrm(intervals: ReportInterval[], matchedDays: AlignedDay[], paired: number[]): number | null {
  if (matchedDays.length === 0 || paired.length === 0) return null;
  const actuals = paired.map((i) => intervals[i].actualKwh).filter((v): v is number => v !== null);
  const meanActual = actuals.length ? actuals.reduce((a, b) => a + b, 0) / actuals.length : null;
  if (meanActual === null || meanActual <= 0) return null;
  let within = 0;
  let total = 0;
  for (const day of matchedDays) {
    for (const i of paired) {
      const iv = day.intervals.find((x) => x.localTime === intervals[i].localTime);
      if (!iv || iv.kwh === null) continue;
      total++;
      if (Math.abs(iv.kwh - meanActual) / meanActual <= 0.25) within++;
    }
  }
  return total === 0 ? null : round((within / total) * 100, 1);
}

export function pickMethod(
  methods: MethodResult[],
  policy: ExclusionConfig['autoPolicy'],
  override: MethodId | null,
): { method: MethodId | null; reason: string; policyLabel: string } {
  const usable = methods.filter((m) => m.applicable);
  if (override) {
    const m = methods.find((x) => x.method === override);
    return {
      method: override,
      reason: m?.applicable
        ? `Manual override: ${override} selected.`
        : `Manual override ${override} does not pass its own checks and is shown for review only.`,
      policyLabel: 'manual',
    };
  }
  if (usable.length === 0) return { method: null, reason: 'No rule passes its applicability checks.', policyLabel: policy };
  const scoreOf = (m: MethodResult): [number, number, number] => {
    const cov = m.coverage.pairedFraction;
    const unc = m.uncertaintyPct ?? 999;
    if (policy === 'prefer_matched') return [m.method === 'weather_regression' ? 0 : 1, cov, -unc];
    if (policy === 'prefer_weather') return [m.method === 'weather_regression' ? 1 : 0, cov, -unc];
    return [cov, -unc, 0];
  };
  const sorted = [...usable].sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return a.method.localeCompare(b.method);
  });
  const best = sorted[0];
  const reason =
    policy === 'min_uncertainty'
      ? `Selected for highest paired coverage (${(best.coverage.pairedFraction * 100).toFixed(1)}%) with the narrower uncertainty band among the applicable rules.`
      : policy === 'prefer_matched'
        ? 'Policy prefers matched-day rules; selected the applicable matched rule with the best coverage and narrowest band.'
        : 'Policy prefers the regression rule; selected it because it passed its checks.';
  return { method: best.method, reason, policyLabel: policy };
}

export function deltaVsSelected(m: MethodResult, selected: MethodResult | undefined): MethodResult['deltaVsSelected'] {
  if (!selected || selected.method === m.method || m.baselineKwh === null || selected.baselineKwh === null) return null;
  const bDiff = m.baselineKwh - selected.baselineKwh;
  const sDiff = m.savingsKwh !== null && selected.savingsKwh !== null ? m.savingsKwh - selected.savingsKwh : null;
  return {
    baselineKwh: round(bDiff, 1)!,
    savingsKwh: sDiff === null ? null : round(sDiff, 1),
    savingsDiffKwh: sDiff === null ? null : round(sDiff, 1),
    savingsPctOfBaseline: selected.baselineKwh > 0 && sDiff !== null ? round((sDiff / selected.baselineKwh) * 100, 2) : null,
    coveragePts: round((m.coverage.pairedFraction - selected.coverage.pairedFraction) * 100, 1),
    note: `This rule’s baseline differs from the selected rule by ${round(bDiff, 1)} kWh; its savings differ by ${sDiff === null ? '—' : round(sDiff, 1)} kWh.`,
  };
}

export function exclusionsFingerprint(cfg: ExclusionConfig): string {
  return hashOf(cfg);
}

void crewBlocks;
void diffDays;
void dayBoundsUtc;
void localDateStr;
