/**
 * Version-consistent report comparison.
 *
 * Two reports are only directly comparable when they share the same basis:
 * dataset version, event revision (hence window), exclusion configuration and
 * rule. Anything else is reported as a mismatch instead of being silently
 * subtracted, because a difference caused by a moved window or a different
 * exclusion set is not a difference caused by the response.
 *
 * A common-window delta is computed on the intersection of the two report
 * windows so a revision that moved the dispatch can still be compared on the
 * hours both revisions cover.
 */

import { round } from './util.js';
import type {
  CompareMismatch,
  CompareResult,
  CompareSide,
  MethodId,
  Report,
  ReportInterval,
  ReportWindow,
} from './types.js';

export interface CompareOptions {
  a: Report;
  b: Report;
  labelA?: string;
  labelB?: string;
}

function sideOf(r: Report, label: string): CompareSide {
  return {
    id: r.id,
    label,
    datasetVersionId: r.datasetVersionId,
    eventRevisionId: r.eventRevisionId,
    revisionNumber: r.revisionNumber,
    method: r.method,
    exclusionsHash: r.basis.exclusionsHash,
    businessHash: r.basis.businessHash,
    windowHash: r.basis.windowHash,
    window: r.window,
    baselineKwh: r.results.baselineKwh,
    savingsKwh: r.results.savingsKwh,
    savingsCi90: r.results.savingsCi90,
    attributableCoverage: r.results.attributableCoverage,
    intervals: r.intervals,
  };
}

function mm(
  field: string,
  label: string,
  a: string,
  b: string,
  severity: CompareMismatch['severity'],
  message: string,
  blocksExact = true,
): CompareMismatch {
  return { field, label, a, b, severity, blocksExact, message };
}

export function compareReports(opts: CompareOptions): CompareResult {
  const { a, b } = opts;
  const mismatches: CompareMismatch[] = [];
  const notes: string[] = [];

  if (a.siteId !== b.siteId) {
    mismatches.push(
      mm('siteId', 'Site', a.siteName, b.siteName, 'critical', 'The two reports cover different sites; savings are not comparable.'),
    );
  }
  if (a.eventId !== b.eventId) {
    mismatches.push(
      mm(
        'eventId',
        'Event',
        `${a.eventId} (${a.eventName})`,
        `${b.eventId} (${b.eventName})`,
        'critical',
        'The two reports cover different dispatch events; savings are not comparable.',
      ),
    );
  }
  if (a.eventRevisionId !== b.eventRevisionId) {
    mismatches.push(
      mm(
        'eventRevisionId',
        'Event revision',
        `rev ${a.revisionNumber} (${a.eventRevisionId})`,
        `rev ${b.revisionNumber} (${b.eventRevisionId})`,
        'warning',
        'Different event revisions: the window may have moved, been rescheduled, or been cancelled.',
      ),
    );
  }
  if (a.datasetVersionId !== b.datasetVersionId) {
    mismatches.push(
      mm(
        'datasetVersionId',
        'Dataset version',
        `${a.datasetVersionId} — ${a.datasetLabel}`,
        `${b.datasetVersionId} — ${b.datasetLabel}`,
        'warning',
        'Different data versions: reads, production records, or meter data were revised between runs.',
      ),
    );
  }
  if (a.basis.windowHash !== b.basis.windowHash) {
    const sameRevision = a.eventRevisionId === b.eventRevisionId;
    mismatches.push(
      mm(
        'windowHash',
        'Window',
        `${a.window.localStart}–${a.window.localEnd} (${a.window.expectedIntervals} intervals)`,
        `${b.window.localStart}–${b.window.localEnd} (${b.window.expectedIntervals} intervals)`,
        sameRevision ? 'critical' : 'warning',
        sameRevision
          ? 'The same revision resolves to different UTC windows in the two reports.'
          : 'The response window moved between the two revisions, so only the overlapping hours are directly comparable.',
        !sameRevision,
      ),
    );
  }
  if (a.basis.exclusionsHash !== b.basis.exclusionsHash) {
    mismatches.push(
      mm(
        'exclusionsHash',
        'Exclusion settings',
        a.basis.exclusionsHash,
        b.basis.exclusionsHash,
        'warning',
        'The exclusion configuration differs; interval membership, and therefore the savings, changed by construction.',
      ),
    );
  }
  if (a.basis.businessHash !== b.basis.businessHash) {
    mismatches.push(
      mm(
        'businessHash',
        'Business rules',
        a.basis.businessHash,
        b.basis.businessHash,
        'warning',
        'Production/holiday/event-day exclusion rules differ between the runs.',
      ),
    );
  }
  if (a.method !== b.method) {
    mismatches.push(
      mm(
        'method',
        'Baseline rule',
        a.methodLabel,
        b.methodLabel,
        'info',
        'A different baseline rule was selected. Part of the difference is rule choice, not response.',
      ),
    );
  }
  if (a.basis.suiteHash !== b.basis.suiteHash) {
    mismatches.push(
      mm(
        'suiteHash',
        'Rule suite / policy',
        a.basis.suiteHash,
        b.basis.suiteHash,
        'info',
        'The rule suite or auto-selection policy differs between the two runs.',
      ),
    );
  }

  const critical = mismatches.some((m) => m.severity === 'critical');
  const revisionLevel =
    a.eventRevisionId !== b.eventRevisionId || a.datasetVersionId !== b.datasetVersionId || a.basis.windowHash !== b.basis.windowHash;
  const methodLevel = a.method !== b.method || a.basis.exclusionsHash !== b.basis.exclusionsHash || a.basis.businessHash !== b.basis.businessHash;

  const comparability: CompareResult['comparability'] = critical
    ? 'incomparable'
    : revisionLevel
      ? 'revision'
      : methodLevel
        ? 'method'
        : 'exact';

  if (comparability === 'exact') {
    notes.push('Both reports share the same basis: identical dataset, revision, window, exclusions, and rule.');
  } else if (comparability === 'revision') {
    notes.push(
      'The reports differ in data revision or event revision. Use the common-window delta to separate the effect of new data from the effect of a moved window.',
    );
  } else if (comparability === 'method') {
    notes.push('The reports share the same event and data but use different exclusion settings or baseline rules.');
  } else {
    notes.push('The reports are not comparable: they cover different sites or events, or the window could not be resolved consistently.');
  }

  const common = commonWindow(a, b);

  const deltas =
    comparability === 'incomparable'
      ? null
      : {
          baselineKwh: diff(a.results.baselineKwh, b.results.baselineKwh),
          savingsKwh: diff(a.results.savingsKwh, b.results.savingsKwh),
          savingsPctOfBaseline: diff(a.results.savingsPct, b.results.savingsPct),
          attributableCoveragePts:
            a.results.attributableCoverage !== null && b.results.attributableCoverage !== null
              ? round((b.results.attributableCoverage - a.results.attributableCoverage) * 100, 2)
              : null,
          intervalCount: b.intervals.length - a.intervals.length,
        };

  return {
    comparable: comparability !== 'incomparable',
    comparability,
    mismatches,
    a: sideOf(a, opts.labelA ?? 'A'),
    b: sideOf(b, opts.labelB ?? 'B'),
    deltas,
    commonWindow: common,
    notes,
  };
}

function diff(base: number | null, other: number | null): number | null {
  if (base === null || other === null) return null;
  return round(other - base, 2);
}

function indexByTs(intervals: ReportInterval[]): Map<number, ReportInterval> {
  const m = new Map<number, ReportInterval>();
  for (const iv of intervals) m.set(iv.tsUtc, iv);
  return m;
}

function commonWindow(a: Report, b: Report): CompareResult['commonWindow'] {
  const startUtc = Math.max(a.window.startUtc, b.window.startUtc);
  const endUtc = Math.min(a.window.endUtc, b.window.endUtc);
  if (!(endUtc > startUtc)) return null;

  const ia = indexByTs(a.intervals);
  const ib = indexByTs(b.intervals);
  const shared = [...ia.keys()].filter((ts) => ib.has(ts) && ts >= startUtc && ts < endUtc).sort((x, y) => x - y);
  if (shared.length === 0) return null;

  const summarize = (idx: Map<number, ReportInterval>) => {
    let baselineKwh = 0;
    let actualKwh = 0;
    let attributable = 0;
    let pairedBaseline = 0;
    let pairedActual = 0;
    for (const ts of shared) {
      const iv = idx.get(ts)!;
      if (iv.actualKwh !== null) actualKwh += iv.actualKwh;
      if (iv.baselineKwh !== null) baselineKwh += iv.baselineKwh;
      if (iv.attributable) attributable++;
      if (iv.baselineKwh !== null && iv.actualKwh !== null) {
        pairedBaseline += iv.baselineKwh;
        pairedActual += iv.actualKwh;
      }
    }
    const savings = pairedBaseline > 0 ? pairedBaseline - pairedActual : null;
    return { baselineKwh: round(baselineKwh, 1)!, actualKwh: round(actualKwh, 1)!, savingsKwh: round(savings, 1), attributable };
  };

  const sa = summarize(ia);
  const sb = summarize(ib);
  return {
    startUtc,
    endUtc,
    minutes: Math.round((endUtc - startUtc) / 60000),
    intervals: shared.length,
    a: sa,
    b: sb,
    deltaSavingsKwh: sa.savingsKwh !== null && sb.savingsKwh !== null ? round(sb.savingsKwh - sa.savingsKwh, 1) : null,
  };
}

/** Human-readable window label used by compare views and CSV exports. */
export function windowLabel(w: ReportWindow): string {
  return `${w.localStart} → ${w.localEnd} (${w.offsetStart}${w.dstTransition ? ', DST transition' : ''})`;
}

/** CSV of the selected rule's per-interval series, suitable for audit export. */
export function reportCsv(r: Report): string {
  const lines = [
    'index,ts_utc,local_date,local_time,utc_offset,temp_f,baseline_kwh,baseline_ci_low,baseline_ci_high,actual_kwh,actual_quality,baseline_status,actual_status,attributable,exclusion_codes,production_status,meter_id,observed_delta_kwh',
  ];
  for (const iv of r.intervals) {
    lines.push(
      [
        iv.index,
        new Date(iv.tsUtc).toISOString(),
        iv.localDate,
        iv.localTime,
        offset(iv.offsetMinutes),
        fmt(iv.tempF),
        fmt(iv.baselineKwh),
        fmt(iv.baselineCi90?.[0] ?? null),
        fmt(iv.baselineCi90?.[1] ?? null),
        fmt(iv.actualKwh),
        iv.actualQuality ?? '',
        iv.baselineStatus,
        iv.actualStatus,
        iv.attributable ? 'yes' : 'no',
        csvCell(iv.exclusionCodes.join('|')),
        iv.productionStatus,
        iv.meterId ?? '',
        fmt(iv.observedDeltaKwh),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function fmt(x: number | null): string {
  return x === null || !Number.isFinite(x) ? '' : String(round(x, 3));
}

function offset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ReportSummary {
  id: string;
  createdAt: number;
  taskId: string;
  taskLabel: string;
  status: Report['status'];
  statusLabel: string;
  claimable: boolean;
  siteId: string;
  siteName: string;
  eventId: string;
  eventName: string;
  eventRevisionId: string;
  revisionNumber: number;
  datasetVersionId: string;
  datasetLabel: string;
  method: MethodId | null;
  methodLabel: string;
  windowStartUtc: number;
  windowEndUtc: number;
  localStart: string;
  localEnd: string;
  baselineKwh: number | null;
  savingsKwh: number | null;
  savingsCi90: [number, number] | null;
  savingsPct: number | null;
  attributableCoverage: number;
  exclusionsHash: string;
  parentReportId: string | null;
}

export function summarizeReport(r: Report): ReportSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    taskId: r.taskId,
    taskLabel: r.taskLabel,
    status: r.status,
    statusLabel: r.statusLabel,
    claimable: r.claimable,
    siteId: r.siteId,
    siteName: r.siteName,
    eventId: r.eventId,
    eventName: r.eventName,
    eventRevisionId: r.eventRevisionId,
    revisionNumber: r.revisionNumber,
    datasetVersionId: r.datasetVersionId,
    datasetLabel: r.datasetLabel,
    method: r.method,
    methodLabel: r.methodLabel,
    windowStartUtc: r.window.startUtc,
    windowEndUtc: r.window.endUtc,
    localStart: r.window.localStart,
    localEnd: r.window.localEnd,
    baselineKwh: r.results.baselineKwh,
    savingsKwh: r.results.savingsKwh,
    savingsCi90: r.results.savingsCi90,
    savingsPct: r.results.savingsPct,
    attributableCoverage: r.results.attributableCoverage,
    exclusionsHash: r.basis.exclusionsHash,
    parentReportId: r.parentReportId,
  };
}
