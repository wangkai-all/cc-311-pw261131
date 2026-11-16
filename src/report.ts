/**
 * Report assembly: resolves the event window (revisions, time basis, DST,
 * cancellation), applies per-interval attribution exclusions, evaluates all
 * three baseline rules, and packages a report with an explicit basis
 * fingerprint.
 */

import { alignSite } from './alignment.js';
import {
  buildCandidates,
  buildMethod,
  DEFAULT_EXCLUSIONS,
  deltaVsSelected,
  eventMetrics,
  METHOD_LABELS,
  pickMethod,
  productionStatusLabel,
  METHOD_IDS,
} from './baseline.js';
import { dayBoundsUtc, enumerateDates, formatLocalWithOffset, localDateStr, localTimeStr, offsetLabel } from './time.js';
import { hashOf, round } from './util.js';
import type {
  AlignedDay,
  DatasetVersion,
  EventRevision,
  ExclusionConfig,
  ExclusionDetail,
  MethodId,
  MethodResult,
  Report,
  ReportInterval,
  ReportResults,
  ReportWarning,
  ReportWindow,
  Site,
  SiteAlignment,
  TaskConfig,
} from './types.js';

const INTERVAL_MS = 15 * 60 * 1000;

export interface ResolvedWindow {
  window: ReportWindow;
  revision: EventRevision;
  status: 'ok' | 'cancelled_no_window' | 'not_participating' | 'no_revision';
  notes: string[];
}

export function resolveWindow(
  dataset: DatasetVersion,
  site: Site,
  eventId: string,
  revisionId: string | null,
): ResolvedWindow {
  const event = dataset.events.find((e) => e.id === eventId);
  if (!event) throw new Error(`unknown event ${eventId}`);
  const revision = revisionId ? event.revisions.find((r) => r.id === revisionId) : event.revisions[event.revisions.length - 1];
  if (!revision) throw new Error(`unknown revision ${revisionId} for ${eventId}`);
  const notes: string[] = [];
  const startUtc = revision.startUtc;
  const endUtc = revision.endUtc;
  const localDates: string[] = [];
  const base: Omit<ReportWindow, 'startUtc' | 'endUtc' | 'localStart' | 'localEnd' | 'offsetStart' | 'offsetEnd' | 'expectedIntervals' | 'localDates' | 'dstTransition'> = {
    scheduledStartUtc: startUtc,
    scheduledEndUtc: endUtc,
    cancelledAtUtc: revision.cancellationAtUtc,
    cancellationReason: revision.cancellationReason,
    truncatedByCancellation: false,
    timeBasis: revision.timeBasis,
  };

  if (startUtc === null || endUtc === null) {
    return {
      status: 'no_revision',
      revision,
      notes: ['Revision has no resolvable UTC window.'],
      window: {
        ...base,
        startUtc: 0,
        endUtc: 0,
        localStart: '—',
        localEnd: '—',
        offsetStart: '—',
        offsetEnd: '—',
        expectedIntervals: 0,
        localDates: [],
        dstTransition: false,
      },
    };
  }

  if (revision.status === 'cancelled') {
    notes.push(
      `Revision ${revision.revision} is cancelled (${revision.cancellationAtUtc ? new Date(revision.cancellationAtUtc).toISOString() : 'no timestamp'}): ${revision.cancellationReason ?? 'no reason recorded'}.`,
    );
    // Show the scheduled window as context; mark it as no-response. The count is
    // of window intervals, not of the whole calendar day, so a cancelled
    // three-hour dispatch reads as 12 intervals rather than 96.
    const dates = enumerateDates(localDateStr(startUtc, site.timezone), localDateStr(Math.max(startUtc, endUtc - 1), site.timezone));
    const expected = Math.ceil((endUtc - startUtc) / INTERVAL_MS);
    return {
      status: 'cancelled_no_window',
      revision,
      notes,
      window: {
        ...base,
        startUtc,
        endUtc,
        localStart: formatLocalWithOffset(startUtc, site.timezone),
        localEnd: formatLocalWithOffset(endUtc, site.timezone),
        offsetStart: offsetLabel(startUtc, site.timezone),
        offsetEnd: offsetLabel(endUtc, site.timezone),
        expectedIntervals: expected,
        localDates: dates,
        dstTransition: expected !== Math.round((endUtc - startUtc) / INTERVAL_MS),
        truncatedByCancellation: true,
      },
    };
  }

  if (!revision.siteIds.includes(site.id)) {
    return {
      status: 'not_participating',
      revision,
      notes: [`Site ${site.id} is not in revision ${revision.revision}’s site list (${revision.siteIds.join(', ')}).`],
      window: {
        ...base,
        startUtc,
        endUtc,
        localStart: formatLocalWithOffset(startUtc, site.timezone),
        localEnd: formatLocalWithOffset(endUtc, site.timezone),
        offsetStart: offsetLabel(startUtc, site.timezone),
        offsetEnd: offsetLabel(endUtc, site.timezone),
        expectedIntervals: 0,
        localDates: [],
        dstTransition: false,
      },
    };
  }

  const startDate = localDateStr(startUtc, site.timezone);
  const endDate = localDateStr(Math.max(startUtc, endUtc - 1), site.timezone);
  const dates = enumerateDates(startDate, endDate);
  const expected = Math.ceil((endUtc - startUtc) / INTERVAL_MS);
  const dst = offsetLabel(startUtc, site.timezone) !== offsetLabel(Math.max(startUtc, endUtc - 1), site.timezone);
  if (dst) {
    notes.push(
      `The window crosses a UTC-offset change (${offsetLabel(startUtc, site.timezone)} → ${offsetLabel(Math.max(startUtc, endUtc - 1), site.timezone)}). Interval count follows real elapsed time, not the wall clock.`,
    );
  }
  const durationMinutes = Math.round((endUtc - startUtc) / 60000);
  if (revision.timeBasis === 'site_local' && durationMinutes !== 180 && revision.timeBasis === 'site_local') {
    notes.push(`Window length is ${durationMinutes} minutes of real elapsed time.`);
  }
  return {
    status: 'ok',
    revision,
    notes,
    window: {
      ...base,
      startUtc,
      endUtc,
      localStart: formatLocalWithOffset(startUtc, site.timezone),
      localEnd: formatLocalWithOffset(endUtc, site.timezone),
      offsetStart: offsetLabel(startUtc, site.timezone),
      offsetEnd: offsetLabel(Math.max(startUtc, endUtc - 1), site.timezone),
      expectedIntervals: expected,
      localDates: dates,
      dstTransition: dst,
    },
  };
}

/** Local date immediately before the earliest analysis-relevant instant. */
function cutoffFor(window: ResolvedWindow, site: Site, revision: EventRevision): { cutoffUtc: number; cutoffDate: string } {
  // Training ends at the start of the event's local day: no reading from the
  // event day or later can be used, regardless of the event window time.
  const eventDate = localDateStr(window.window.startUtc, site.timezone);
  const dayStart = dayBoundsUtc(eventDate, site.timezone).startUtc;
  const cutoffUtc = Math.min(dayStart, window.window.startUtc, revision.issuedAtUtc);
  const cutoffDate = localDateStr(cutoffUtc - 1, site.timezone);
  return { cutoffUtc, cutoffDate };
}

export interface BuildReportOptions {
  dataset: DatasetVersion;
  site: Site;
  eventId: string;
  revisionId: string | null;
  exclusions: ExclusionConfig;
  taskId: string;
  taskLabel: string;
  scope: 'event' | 'training_validation';
  validationDate: string | null;
  reportId: string;
  now: number;
  parentReportId: string | null;
  latestDatasetVersionId: string;
}

interface IntervalExclusion {
  codes: string[];
}

function classifyIntervals(
  alignment: SiteAlignment,
  allDays: AlignedDay[],
  window: ReportWindow,
  cfg: ExclusionConfig,
): { intervals: ReportInterval[]; exclusions: IntervalExclusion[]; reasons: ExclusionDetail[]; warnings: ReportWarning[] } {
  const warnings: ReportWarning[] = [];
  const intervals: ReportInterval[] = [];
  const exclusions: IntervalExclusion[] = [];
  let index = 0;

  for (const day of allDays) {
    for (const iv of day.intervals) {
      if (iv.tsUtc < window.startUtc || iv.tsUtc >= window.endUtc) continue;
      const codes: string[] = [];
      let actualKwh: number | null = iv.kwh;
      let actualStatus: ReportInterval['actualStatus'] = 'ok';

      if (iv.status === 'missing') {
        actualStatus = 'missing';
        actualKwh = null;
        codes.push('missing_actual');
      } else if (iv.status === 'meter_conflict') {
        actualStatus = 'missing';
        actualKwh = null;
        codes.push('meter_conflict');
      } else if (iv.status === 'no_active_meter' || iv.status === 'invalid') {
        actualStatus = 'missing';
        actualKwh = null;
        codes.push('no_active_meter');
      }
      if (cfg.treatEstimatedAsMissing && iv.quality === 'estimated') {
        actualStatus = 'missing';
        actualKwh = null;
        codes.push('estimated_read');
      }
      const prodExcluded = iv.productionStatus !== 'normal' && cfg.excludeProductionStatuses.includes(iv.productionStatus);
      // Unverified anomalies are treated per the *record*, not the merged status:
      // a verified maintenance entry must not hide an unverified outage on the
      // same interval, and vice versa.
      const unverified = iv.productionRecords.some((p) => p.status !== 'normal' && !p.verified);
      if (prodExcluded) {
        codes.push(`production_${iv.productionStatus}`);
        if (actualKwh !== null) actualStatus = 'excluded';
      }
      // A verified maintenance entry must not mask an unverified outage on the
      // same interval: the unverified reason is recorded independently.
      if (cfg.excludeUnverifiedProduction && unverified) {
        codes.push('production_unverified');
        if (actualKwh !== null) actualStatus = 'excluded';
      } else if (!cfg.excludeUnverifiedProduction && unverified && !prodExcluded) {
        if (!warnings.some((w) => w.code === 'unverified_production_in_actual')) {
          warnings.push({
            code: 'unverified_production_in_actual',
            severity: 'warning',
            message:
              'The response window includes an unverified production anomaly that is not excluded; savings may include production effects.',
            detail: 'Set excludeUnverifiedProduction to exclude these intervals from the attributable window.',
          });
        }
      }
      if (day.dstTransition && cfg.excludeDstTransitionDays) {
        codes.push('dst_transition_day');
        if (actualKwh !== null) actualStatus = 'excluded';
      }
      if (day.meterExchange && cfg.excludeMeterExchangeDays) {
        codes.push('meter_exchange_day');
        if (actualKwh !== null) actualStatus = 'excluded';
      }
      const unique = [...new Set(codes)];
      intervals.push({
        index,
        tsUtc: iv.tsUtc,
        localDate: localDateStr(iv.tsUtc, alignment.site.timezone),
        localTime: iv.localTime,
        offsetMinutes: iv.offsetMinutes,
        tempF: iv.tempF,
        baselineKwh: null,
        baselineCi90: null,
        actualKwh,
        actualQuality: iv.quality,
        baselineStatus: 'missing',
        actualStatus,
        attributable: unique.length === 0 && actualKwh !== null,
        exclusionCodes: unique,
        productionStatus: iv.productionStatus,
        productionVerifiedAnomaly: iv.productionRecords.some((p) => p.status !== 'normal' && p.verified),
        productionUnverifiedAnomaly: iv.productionRecords.some((p) => p.status !== 'normal' && !p.verified),
        meterId: iv.meterId,
        observedDeltaKwh: null,
        isDerivedWeather: iv.tempSource === 'nearest',
      });
      exclusions.push({ codes: unique });
      index++;
    }
  }

  // Roll up by code with contiguous index ranges.
  const byCode = new Map<string, { count: number; kWh: number; indices: number[] }>();
  exclusions.forEach((e, i) => {
    for (const code of e.codes) {
      const rec = byCode.get(code) ?? { count: 0, kWh: 0, indices: [] };
      rec.count++;
      rec.kWh += intervals[i].actualKwh ?? 0;
      rec.indices.push(i);
      byCode.set(code, rec);
    }
  });
  const reasons: ExclusionDetail[] = [...byCode.entries()].map(([code, rec]) => ({
    code,
    label: exclusionLabel(code),
    count: rec.count,
    kWh: round(rec.kWh, 1),
    indexRanges: compressRanges(rec.indices),
    perIntervalKwh: round(rec.kWh / rec.count, 2),
  }));
  reasons.sort((a, b) => b.count - a.count);

  if (byCode.has('estimated_read')) {
    warnings.push({
      code: 'estimated_reads_excluded',
      severity: 'warning',
      message: 'Some window intervals carry estimated reads. They are excluded from savings, not counted as measured.',
      detail: `${byCode.get('estimated_read')!.count} intervals.`,
    });
  }
  if (byCode.has('missing_actual')) {
    warnings.push({
      code: 'missing_reads_excluded',
      severity: 'warning',
      message: 'Some window intervals have no reading. They are excluded from attribution and were not filled with zero.',
      detail: `${byCode.get('missing_actual')!.count} intervals.`,
    });
  }
  if (byCode.has('meter_conflict')) {
    warnings.push({
      code: 'meter_conflict_excluded',
      severity: 'warning',
      message: 'Some window intervals have readings from two active meters and are excluded rather than averaged.',
      detail: `${byCode.get('meter_conflict')!.count} intervals.`,
    });
  }
  for (const status of ['planned_maintenance', 'unplanned_shutdown', 'reduced', 'non_routine'] as const) {
    if (byCode.has(`production_${status}`)) {
      warnings.push({
        code: `production_${status}`,
        severity: 'critical',
        message: `Window intervals overlap a recorded ${productionStatusLabel(status)} event. They are excluded from savings so a production stoppage is not credited as demand response.`,
        detail: `${byCode.get(`production_${status}`)!.count} intervals.`,
      });
    }
  }
  if (byCode.has('production_unverified')) {
    warnings.push({
      code: 'production_unverified',
      severity: 'warning',
      message: 'Window intervals overlap an unverified production anomaly that you chose to exclude.',
      detail: `${byCode.get('production_unverified')!.count} intervals.`,
    });
  }
  if (byCode.has('meter_exchange_day')) {
    warnings.push({
      code: 'meter_exchange_day',
      severity: 'warning',
      message: 'The window falls on a meter-exchange day and exchange-day exclusion is enabled.',
      detail: `${byCode.get('meter_exchange_day')!.count} intervals.`,
    });
  }

  return { intervals, exclusions, reasons, warnings };
}

function exclusionLabel(code: string): string {
  const labels: Record<string, string> = {
    missing_actual: 'No actual reading (missing interval)',
    meter_conflict: 'Conflicting readings from two active meters',
    no_active_meter: 'No active meter',
    estimated_read: 'Estimated read excluded',
    dst_transition_day: 'DST transition day excluded',
    meter_exchange_day: 'Meter-exchange day excluded',
    production_planned_maintenance: 'Planned maintenance',
    production_unplanned_shutdown: 'Unplanned shutdown',
    production_reduced: 'Reduced production',
    production_non_routine: 'Non-routine operation',
    production_unverified: 'Unverified production anomaly (excluded by choice)',
  };
  return labels[code] ?? code;
}

function compressRanges(indices: number[]): string {
  if (indices.length === 0) return '—';
  const sorted = [...indices].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      parts.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.slice(0, 8).join(', ') + (parts.length > 8 ? `, +${parts.length - 8} more` : '');
}

function attachSelectedSeries(intervals: ReportInterval[], selected: MethodResult | undefined): void {
  if (!selected) return;
  const byTs = new Map(selected.series.map((p) => [p.tsUtc, p]));
  for (const iv of intervals) {
    const point = byTs.get(iv.tsUtc);
    if (!point) continue;
    iv.baselineKwh = point.baselineKwh;
    iv.baselineCi90 = point.ci90;
    iv.baselineStatus = point.baselineKwh === null ? 'missing' : 'ok';
    if (iv.baselineKwh !== null && iv.actualKwh !== null) {
      iv.observedDeltaKwh = round(iv.baselineKwh - iv.actualKwh, 3);
    }
  }
}

export function buildReport(opts: BuildReportOptions): Report {
  const { dataset, site, eventId, revisionId, exclusions, scope } = opts;
  const event = dataset.events.find((e) => e.id === eventId);
  if (!event) throw new Error(`Unknown event ${eventId}`);
  const resolved = resolveWindow(dataset, site, eventId, revisionId);
  const alignment = alignSite(dataset, site);
  const warnings: ReportWarning[] = [];
  const notes: string[] = [...resolved.notes];

  const basisBase = {
    datasetVersionId: dataset.id,
    datasetLabel: dataset.label,
    siteId: site.id,
    eventId,
    eventRevisionId: resolved.revision.id,
    exclusionsHash: hashOf(exclusions),
    businessHash: hashOf({
      production: exclusions.excludeProductionStatuses,
      fx: exclusions.excludeUnverifiedProduction,
      holidays: exclusions.excludeHolidays,
      eventDays: exclusions.excludeEventDays,
      dst: exclusions.excludeDstTransitionDays,
      meter: exclusions.excludeMeterExchangeDays,
      est: exclusions.treatEstimatedAsMissing,
    }),
    windowHash: hashOf({ start: resolved.window.startUtc, end: resolved.window.endUtc, revision: resolved.revision.id }),
  };

  const emptyResults: ReportResults = {
    baselineKwh: null,
    baselineCi90: null,
    actualKwh: null,
    savingsKwh: null,
    savingsCi90: null,
    savingsPct: null,
    observedDropKwh: null,
    observedDropPct: null,
    nonDrDropKwh: null,
    savingsIsPartial: false,
    attributableCoverage: 0,
    actualCoverage: 0,
    baselineCoverage: 0,
    estimatedKwhInActual: 0,
    estimatedKwhInBaseline: 0,
    attributionNote: '',
  };

  const baseReport = (status: Report['status'], statusLabel: string, claimable: boolean): Report => ({
    id: opts.reportId,
    createdAt: opts.now,
    taskId: opts.taskId,
    taskLabel: opts.taskLabel,
    scope,
    validationDate: opts.validationDate,
    status,
    statusLabel,
    claimable,
    datasetVersionId: dataset.id,
    datasetLabel: dataset.label,
    latestDatasetVersionId: opts.latestDatasetVersionId,
    siteId: site.id,
    siteName: site.name,
    siteTimezone: site.timezone,
    eventId,
    eventName: event.name,
    eventRevisionId: resolved.revision.id,
    revisionNumber: resolved.revision.revision,
    revisionStatus: resolved.revision.status,
    method: null,
    methodLabel: '—',
    methodPolicy: scope === 'training_validation' ? 'validation' : exclusions.methodOverride ? 'manual' : exclusions.autoPolicy,
    basis: {
      ...basisBase,
      method: 'weather_regression',
      suiteHash: hashOf({ methods: METHOD_IDS, exclusions: hashOf(exclusions) }),
    },
    exclusions,
    window: resolved.window,
    boardTime: formatLocalWithOffset(resolved.window.startUtc, site.timezone),
    intervals: [],
    methods: [],
    results: emptyResults,
    attribution: {
      expected: 0,
      actualCoverage: 0,
      baselineCoverage: 0,
      attributable: 0,
      missing: 0,
      conflict: 0,
      productionAffected: 0,
      meterExchangeAffected: 0,
      reasons: [],
      missingIntervals: 0,
    },
    uncertainty: {
      level: exclusions.confidenceLevel,
      unit: 'kWh',
      bootstrapUnit: 'day',
      replicates: exclusions.bootstrapReplicates,
      seed: 0,
      method: '—',
      note: 'Not computed for this report status.',
      suggestions: [],
    },
    warnings,
    notes,
    parentReportId: opts.parentReportId,
  });

  if (resolved.status === 'cancelled_no_window') {
    warnings.push({
      code: 'event_cancelled',
      severity: 'info',
      message: 'This event revision is cancelled. No savings are computed and the scheduled window is shown only for context.',
      detail: resolved.revision.cancellationReason ?? undefined,
    });
    const report = baseReport('no_window', 'Event cancelled — no response window', false);
    return report;
  }
  if (resolved.status === 'not_participating') {
    warnings.push({
      code: 'site_not_participating',
      severity: 'warning',
      message: 'This site is not part of the selected event revision.',
    });
    return baseReport('no_window', 'Site not participating in this revision', false);
  }
  if (resolved.status === 'no_revision') {
    warnings.push({
      code: 'no_resolvable_window',
      severity: 'critical',
      message: 'The revision has no resolvable UTC window; check the time basis and timestamps.',
    });
    return baseReport('no_window', 'No resolvable window', false);
  }

  if (scope === 'training_validation' && opts.validationDate) {
    // A validation report deliberately uses a pseudo-event at the chosen date so
    // the analyst can see how the rules would have performed on a known day.
    const day = alignment.days.get(opts.validationDate);
    if (!day) {
      warnings.push({
        code: 'validation_date_missing',
        severity: 'critical',
        message: `Validation date ${opts.validationDate} is outside the dataset’s aligned range.`,
      });
      return baseReport('no_window', 'Validation date not in range', false);
    }
  }

  // ---- candidate set & cutoff ----
  const cutoff = cutoffFor(resolved, site, resolved.revision);
  const ctx = {
    alignment,
    window: { startUtc: resolved.window.startUtc, endUtc: resolved.window.endUtc },
    eventDate: localDateStr(resolved.window.startUtc, site.timezone),
    eventLocalDates: resolved.window.localDates,
    cutoffUtc: cutoff.cutoffUtc,
    cutoffDate: cutoff.cutoffDate,
    exclusions,
    timezone: site.timezone,
    windowSlots: [
      ...new Set(
        alignment.dayList
          .flatMap((d) => d.intervals)
          .filter((iv) => iv.tsUtc >= resolved.window.startUtc && iv.tsUtc < resolved.window.endUtc)
          .map((iv) => iv.localTime),
      ),
    ],
  };
  const candidates = buildCandidates(ctx);

  // ---- intervals & attribution ----
  const classified = classifyIntervals(alignment, alignment.dayList, resolved.window, exclusions);
  const intervals = classified.intervals;
  const expected = intervals.length;
  const attributable = intervals.filter((r) => r.attributable && r.actualKwh !== null);
  const actualCoverage = expected === 0 ? 0 : attributable.length / expected;
  const estimatedKwhInActual = attributable
    .filter((r) => r.actualQuality === 'estimated')
    .reduce((a, r) => a + (r.actualKwh ?? 0), 0);

  const reasonsByCode = new Map(classified.reasons.map((r) => [r.code, r]));
  const actualKwhRaw = intervals.reduce((a, r) => a + (r.actualKwh ?? 0), 0);

  if (attributable.length === 0) {
    warnings.push({
      code: 'no_attributable_intervals',
      severity: 'critical',
      message: 'No window interval survives the exclusion rules, so no savings can be attributed.',
      detail: classified.reasons.map((r) => `${r.label}: ${r.count}`).join('; '),
    });
    const report = baseReport('insufficient_attribution', 'No attributable intervals', false);
    report.intervals = intervals;
    report.attribution = {
      expected,
      actualCoverage,
      baselineCoverage: 0,
      attributable: 0,
      missing: reasonsByCode.get('missing_actual')?.count ?? 0,
      conflict: reasonsByCode.get('meter_conflict')?.count ?? 0,
      productionAffected: classified.reasons.filter((r) => r.code.startsWith('production_')).reduce((a, r) => a + r.count, 0),
      meterExchangeAffected: reasonsByCode.get('meter_exchange_day')?.count ?? 0,
      reasons: classified.reasons,
      missingIntervals: reasonsByCode.get('missing_actual')?.count ?? 0,
    };
    report.results = {
      ...emptyResults,
      actualKwh: round(actualKwhRaw, 1),
      actualCoverage,
      attributableCoverage: 0,
      attributionNote: 'No window interval is attributable, so no baseline or savings figure is reported.',
    };
    return report;
  }

  if (actualCoverage < exclusions.minActualCoverage) {
    warnings.push({
      code: 'low_actual_coverage',
      severity: 'warning',
      message: `Only ${(actualCoverage * 100).toFixed(1)}% of window intervals are attributable, below the configured minimum of ${(exclusions.minActualCoverage * 100).toFixed(0)}%. Savings are reported as partial.`,
    });
  }

  // ---- methods ----
  const seedKey = `${dataset.id}|${site.id}|${eventId}|${resolved.revision.id}|${hashOf(exclusions)}`;
  const built = METHOD_IDS.map((method) =>
    buildMethod({ ctx, candidates, method, reportIntervals: intervals, seedKey }),
  );
  const methods = built.map((b) => b.result);

  // Attach per-interval baseline for the selected method after selection.
  const pick = pickMethod(methods, exclusions.autoPolicy, exclusions.methodOverride);
  const selectedIdx = methods.findIndex((m) => m.method === pick.method);
  const selected = selectedIdx >= 0 ? methods[selectedIdx] : undefined;
  for (const m of methods) {
    m.selected = m.method === pick.method;
    m.selectionReason = m.selected ? pick.reason : '';
  }
  if (pick.method === null) {
    warnings.push({
      code: 'no_applicable_rule',
      severity: 'critical',
      message: 'None of the three rules passes its applicability checks for this event. Figures are shown for diagnosis only.',
    });
  } else if (exclusions.methodOverride) {
    warnings.push({
      code: 'manual_method_override',
      severity: 'info',
      message: `Rule selection is a manual override (${METHOD_LABELS[pick.method]}). Auto-selection would have used a different basis.`,
    });
  }

  const selectedBuilt = selectedIdx >= 0 ? built[selectedIdx] : undefined;
  for (const m of methods) {
    m.deltaVsSelected = deltaVsSelected(m, selected);
  }

  attachSelectedSeries(intervals, selected);

  const baselineCoverage = selected?.baselineCoverage ?? 0;
  const baselineKwh = selected?.baselineKwh ?? null;
  const actualKwh = attributable.reduce((a, r) => a + (r.actualKwh ?? 0), 0);
  const savingsKwh = selected?.savingsKwh ?? null;
  const savingsCi = selected?.savingsCi90 ?? null;
  const savingsPct = selected?.savingsPct ?? null;

  // Observed drop across every window interval with an actual read (even ones
  // excluded from attribution), against the selected baseline.
  const observedPairs = intervals.filter((r) => r.actualKwh !== null && r.baselineKwh !== null);
  const observedBaseline = observedPairs.reduce((a, r) => a + (r.baselineKwh ?? 0), 0);
  const observedActual = observedPairs.reduce((a, r) => a + (r.actualKwh ?? 0), 0);
  const observedDrop = observedPairs.length ? observedBaseline - observedActual : null;
  const observedDropPct = observedBaseline > 0 && observedDrop !== null ? (observedDrop / observedBaseline) * 100 : null;
  const nonDrDrop = observedDrop !== null && savingsKwh !== null ? observedDrop - savingsKwh : null;

  // With the selected method's series attached above, count attributable
  // intervals whose baseline the selected rule could not produce.
  const emptyBaselineIntervals = intervals.filter((r) => r.attributable && r.baselineKwh === null).length;
  const attributionNote =
    attributable.length === expected
      ? 'Every window interval is attributable; no production, missing-read, or conflict adjustment was required.'
      : `Savings are attributed on ${attributable.length} of ${expected} window intervals. The other ${expected - attributable.length} are excluded (not zero-filled) because of missing reads, meter conflicts, estimated reads, or recorded production anomalies.`;

  const results: ReportResults = {
    baselineKwh: baselineKwh === null ? null : round(baselineKwh, 1),
    baselineCi90: selectedBuilt?.baselineCi90
      ? [round(selectedBuilt.baselineCi90[0], 1)!, round(selectedBuilt.baselineCi90[1], 1)!]
      : null,
    actualKwh: round(actualKwh, 1),
    savingsKwh: savingsKwh === null ? null : round(savingsKwh, 1),
    savingsCi90: savingsCi === null ? null : [round(savingsCi[0], 1)!, round(savingsCi[1], 1)!],
    savingsPct: savingsPct === null ? null : round(savingsPct, 2),
    observedDropKwh: observedDrop === null ? null : round(observedDrop, 1),
    observedDropPct: observedDropPct === null ? null : round(observedDropPct, 2),
    nonDrDropKwh: nonDrDrop === null ? null : round(nonDrDrop, 1),
    savingsIsPartial: attributable.length !== expected || emptyBaselineIntervals > 0,
    attributableCoverage: actualCoverage,
    actualCoverage,
    baselineCoverage,
    estimatedKwhInActual: round(estimatedKwhInActual, 1) ?? 0,
    estimatedKwhInBaseline: 0,
    attributionNote,
  };

  // Warning roll-ups from methods.
  const allWarnings = new Set(methods.flatMap((m) => m.warningCodes));
  if (allWarnings.has('temperature_extrapolation')) {
    warnings.push({
      code: 'temperature_extrapolation',
      severity: 'warning',
      message: 'The event window is warmer or colder than every training day in at least one rule. That rule’s temperature correction is extrapolating.',
    });
  }
  if (allWarnings.has('check_failed:slot_depth')) {
    warnings.push({
      code: 'thin_slot_sample',
      severity: 'warning',
      message: 'At least one rule has a 15-minute slot with a thin sample. Its per-slot baseline is less reliable.',
    });
  }
  if (allWarnings.has('loose_temperature_match')) {
    warnings.push({
      code: 'loose_temperature_match',
      severity: 'warning',
      message: 'Matched days ended up further than the configured tolerance in temperature; weather correction is doing more work than usual.',
    });
  }
  if (methods.some((m) => m.sample.slopeKwhPerF !== null && !m.sample.slopeIsValid)) {
    warnings.push({
      code: 'weather_slope_rejected',
      severity: 'info',
      message: 'A fitted temperature slope was rejected (implausible magnitude or too little spread), so no weather correction was applied for that rule.',
    });
  }
  if (candidates.unverifiedAnomalyDays > 0 && !exclusions.excludeUnverifiedProduction) {
    warnings.push({
      code: 'unverified_anomaly_in_history',
      severity: 'warning',
      message: `${candidates.unverifiedAnomalyDays} training-window day(s) contain an unverified production anomaly. They are kept because only verified anomalies are excluded by default; review the production log before relying on the baseline.`,
    });
  }
  if (alignment.summary.missing > 0) {
    warnings.push({
      code: 'dataset_missing_intervals',
      severity: 'info',
      message: `${alignment.summary.missing} intervals in the aligned period have no reading at all.`,
    });
  }

  for (const w of classified.warnings) warnings.push(w);

  if (selected && !selected.applicable) {
    warnings.push({
      code: 'selected_rule_failed_check',
      severity: 'critical',
      message: `The selected rule (${selected.label}) fails at least one applicability check. Treat the number as diagnostic, not a result.`,
      detail: selected.checks.filter((c) => !c.passed).map((c) => c.label).join('; '),
    });
  }

  const claimable =
    selected !== undefined &&
    selected.applicable &&
    actualCoverage >= exclusions.minActualCoverage &&
    selected.coverage.pairedFraction > 0;

  const status: Report['status'] = pick.method === null ? 'no_rule' : claimable ? 'ok' : 'insufficient_attribution';
  const statusLabel =
    pick.method === null
      ? 'No applicable rule'
      : claimable
        ? 'Reportable estimate'
        : 'Partial — below coverage threshold';

  const uncertainty = {
    level: exclusions.confidenceLevel,
    unit: 'kWh' as const,
    bootstrapUnit: 'day' as const,
    replicates: exclusions.bootstrapReplicates,
    seed: hashOf(seedKey).length ? parseInt(hashOf(seedKey).slice(0, 8), 16) : 0,
    method: selected ? `Day-block bootstrap on ${selected.sample.matchedDays} matched days, ${exclusions.bootstrapReplicates} replicates` : '—',
    note:
      'The interval is a percentile bootstrap over training days (5-interval crew blocks kept intact). It reflects sampling variability of the baseline only, not production, meter, or weather-model error.',
    suggestions: [] as string[],
  };

  const report: Report = {
    ...baseReport(status, statusLabel, claimable),
    method: pick.method,
    methodLabel: pick.method ? METHOD_LABELS[pick.method] : '—',
    methodPolicy: scope === 'training_validation' ? 'validation' : exclusions.methodOverride ? 'manual' : exclusions.autoPolicy,
    intervals,
    methods,
    results,
    attribution: {
      expected,
      actualCoverage,
      baselineCoverage,
      attributable: attributable.length,
      missing: reasonsByCode.get('missing_actual')?.count ?? 0,
      conflict: reasonsByCode.get('meter_conflict')?.count ?? 0,
      productionAffected: classified.reasons.filter((r) => r.code.startsWith('production_')).reduce((a, r) => a + r.count, 0),
      meterExchangeAffected: reasonsByCode.get('meter_exchange_day')?.count ?? 0,
      reasons: classified.reasons,
      missingIntervals: reasonsByCode.get('missing_actual')?.count ?? 0,
    },
    uncertainty,
    warnings,
    notes,
    basis: {
      ...basisBase,
      method: pick.method ?? 'weather_regression',
      suiteHash: hashOf({ methods: METHOD_IDS, exclusions: hashOf(exclusions), autoPolicy: exclusions.autoPolicy, override: exclusions.methodOverride }),
    },
  };

  if (scope === 'training_validation' && opts.validationDate) {
    const day = alignment.days.get(opts.validationDate)!;
    report.notes.push(
      `Validation mode: the rules were trained only on days before ${opts.validationDate} and applied to ${opts.validationDate} (${day.presentIntervals}/${day.expectedIntervals} intervals present). There is no “true” counterfactual, so savings on this day are not a claim.`,
    );
    report.status = 'training_only';
    report.statusLabel = 'Validation view — not a savings claim';
    report.claimable = false;
  }

  void selectedBuilt;
  void allDaysUnused();
  return report;
}

function allDaysUnused(): void {
  /* placeholder to keep the import surface explicit */
}

export function mergeExclusions(raw: unknown): ExclusionConfig {
  const cfg: ExclusionConfig = { ...DEFAULT_EXCLUSIONS };
  if (!raw || typeof raw !== 'object') return cfg;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_EXCLUSIONS) as (keyof ExclusionConfig)[]) {
    if (!(key in r)) continue;
    const def = DEFAULT_EXCLUSIONS[key] as unknown;
    const val = r[key];
    if (Array.isArray(def)) {
      if (Array.isArray(val)) (cfg[key] as unknown) = val.filter((v) => typeof v === 'string');
      continue;
    }
    if (typeof def === 'number') {
      const n = Number(val);
      if (Number.isFinite(n)) (cfg[key] as unknown) = n;
      continue;
    }
    if (typeof def === 'boolean') {
      if (typeof val === 'boolean') (cfg[key] as unknown) = val;
      continue;
    }
    if (key === 'autoPolicy') {
      if (val === 'min_uncertainty' || val === 'prefer_matched' || val === 'prefer_weather') cfg.autoPolicy = val;
      continue;
    }
    if (key === 'methodOverride') {
      if (val === null) cfg.methodOverride = null;
      else if (val === 'matched_10of10_weather' || val === 'matched_4of5_weather' || val === 'weather_regression') cfg.methodOverride = val as MethodId;
      continue;
    }
  }
  // Clamp numeric fields into sane ranges so a bad request cannot silently break math.
  cfg.minDayCoverage = clamp01(cfg.minDayCoverage);
  cfg.minActualCoverage = clamp01(cfg.minActualCoverage);
  cfg.minAttributableShare = clamp01(cfg.minAttributableShare);
  cfg.lookbackDays = Math.max(7, Math.min(120, Math.round(cfg.lookbackDays)));
  cfg.matchedDayCount = Math.max(2, Math.min(30, Math.round(cfg.matchedDayCount)));
  cfg.recentPoolSize = Math.max(4, Math.min(20, Math.round(cfg.recentPoolSize)));
  cfg.minMatchedDays = Math.max(2, Math.min(cfg.matchedDayCount, Math.round(cfg.minMatchedDays)));
  cfg.matchTempToleranceF = Math.max(0.5, Math.min(20, cfg.matchTempToleranceF));
  cfg.minMatchTempToleranceF = Math.max(0.5, Math.min(cfg.matchTempToleranceF, cfg.minMatchTempToleranceF));
  cfg.regressionMinDays = Math.max(4, Math.min(60, Math.round(cfg.regressionMinDays)));
  cfg.minSlotSampleRatio = Math.max(0.2, Math.min(1, cfg.minSlotSampleRatio));
  cfg.bootstrapReplicates = Math.max(100, Math.min(5000, Math.round(cfg.bootstrapReplicates)));
  cfg.confidenceLevel = Math.min(0.99, Math.max(0.5, cfg.confidenceLevel));
  cfg.maxWeatherSlopeKwhPerF = Math.max(0.1, Math.min(20, cfg.maxWeatherSlopeKwhPerF));
  cfg.temperatureOverlapMarginF = Math.max(0, Math.min(30, cfg.temperatureOverlapMarginF));
  cfg.excludeProductionStatuses = cfg.excludeProductionStatuses.filter((s) =>
    ['planned_maintenance', 'unplanned_shutdown', 'reduced', 'non_routine'].includes(s),
  );
  return cfg;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function latestReportIntervalSummary(report: Report): { intervals: ReportInterval[] } {
  return { intervals: report.intervals };
}

void differenceInDays;
function differenceInDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

void localTimeStr;
