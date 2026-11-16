import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, mergeExclusions } from '../src/report.js';
import { buildFixture } from './fixture.js';
import type { DatasetVersion } from '../src/types.js';

const build = (
  dataset: DatasetVersion,
  siteIndex: number,
  eventId: string,
  revisionId: string | null = null,
  exclusions: Record<string, unknown> = {},
) =>
  buildReport({
    dataset,
    site: dataset.sites[siteIndex],
    eventId,
    revisionId,
    exclusions: mergeExclusions({ bootstrapReplicates: 200, ...exclusions }),
    taskId: 't',
    taskLabel: 'x',
    scope: 'event',
    validationDate: null,
    reportId: 'r',
    now: Date.parse('2026-09-11T00:00:00Z'),
    parentReportId: null,
    latestDatasetVersionId: dataset.id,
  });

function withRevision(dataset: DatasetVersion, mutate: (rev: DatasetVersion['events'][0]['revisions'][0]) => void): DatasetVersion {
  const rev = dataset.events[0].revisions[0];
  mutate(rev);
  return dataset;
}

test('a cancelled revision yields no window and no savings', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const ds = withRevision(fx.dataset, (rev) => {
    rev.status = 'cancelled';
    rev.cancellationAtUtc = rev.startUtc! - 3600000;
    rev.cancellationReason = 'Severe weather stand-down';
  });
  const r = build(ds, 0, 'EV-T');
  assert.equal(r.status, 'no_window');
  assert.equal(r.results.savingsKwh, null);
  assert.equal(r.window.cancelledAtUtc, ds.events[0].revisions[0].cancellationAtUtc);
  assert.equal(r.window.cancellationReason, 'Severe weather stand-down');
  assert.equal(r.window.truncatedByCancellation, true);
  assert.ok(r.warnings.some((w) => w.code === 'event_cancelled'));
  // The scheduled window is still shown as context, with a window-sized count.
  assert.equal(r.window.expectedIntervals, 12);
});

test('a site missing from the revision is refused, not silently analysed', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const ds = withRevision(fx.dataset, (rev) => {
    rev.siteIds = ['SITE-OTHER'];
  });
  const r = build(ds, 0, 'EV-T');
  assert.equal(r.status, 'no_window');
  assert.ok(r.warnings.some((w) => w.code === 'site_not_participating'));
});

test('a DST-window event counts real elapsed intervals', () => {
  const fx = buildFixture({
    startDate: '2026-10-01',
    endDate: '2026-11-10',
    timezone: 'America/New_York',
    eventDate: '2026-11-01',
    eventStart: '01:00',
    eventEnd: '02:00',
  });
  const r = build(ds(fx), 0, 'EV-T');
  assert.equal(r.window.startUtc, Date.parse('2026-11-01T05:00:00Z'));
  assert.equal(r.window.endUtc, Date.parse('2026-11-01T07:00:00Z'));
  assert.equal(r.window.expectedIntervals, 8, 'the repeated hour has real elapsed time');
  assert.equal(r.window.dstTransition, true);
  assert.equal(r.intervals.length, 8);
});

function ds(fx: ReturnType<typeof buildFixture>): DatasetVersion {
  return fx.dataset;
}

test('production anomalies are excluded and separately reported', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  fx.dataset.production.push({
    id: 'P1',
    siteId: fx.site.id,
    startUtc: Date.parse('2026-08-18T20:00:00Z'),
    endUtc: Date.parse('2026-08-18T23:00:00Z'),
    status: 'unplanned_shutdown',
    verified: true,
    expectedDropPct: 90,
    source: 'test',
    note: 'compressor failure',
  });
  const r = build(fx.dataset, 0, 'EV-T');
  assert.equal(r.status, 'insufficient_attribution');
  assert.ok(r.attribution.reasons.some((x) => x.code === 'production_unplanned_shutdown'));
  assert.equal(r.results.savingsKwh, null);
});

test('an unverified anomaly is used by default but flagged; excluding it is opt-in', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  fx.dataset.production.push({
    id: 'P2',
    siteId: fx.site.id,
    startUtc: Date.parse('2026-08-18T20:00:00Z'),
    endUtc: Date.parse('2026-08-18T23:00:00Z'),
    status: 'non_routine',
    verified: false,
    expectedDropPct: null,
    source: 'shift note',
    note: 'possible jam',
  });
  const loose = build(fx.dataset, 0, 'EV-T', null, { excludeUnverifiedProduction: false });
  assert.equal(loose.status, 'ok');
  assert.ok(loose.warnings.some((w) => w.code === 'unverified_production_in_actual'));
  const strict = build(fx.dataset, 0, 'EV-T', null, { excludeUnverifiedProduction: true });
  assert.equal(strict.status, 'insufficient_attribution');
  assert.ok(strict.attribution.reasons.some((x) => x.code === 'production_unverified'));
});

test('a verified anomaly is not hidden by a merged unverified note, and vice versa', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  fx.dataset.production.push(
    {
      id: 'P3',
      siteId: fx.site.id,
      startUtc: Date.parse('2026-08-18T20:00:00Z'),
      endUtc: Date.parse('2026-08-18T22:00:00Z'),
      status: 'planned_maintenance',
      verified: true,
      expectedDropPct: 40,
      source: 'cmms',
      note: 'planned',
    },
    {
      id: 'P4',
      siteId: fx.site.id,
      startUtc: Date.parse('2026-08-18T20:00:00Z'),
      endUtc: Date.parse('2026-08-18T22:00:00Z'),
      status: 'non_routine',
      verified: false,
      expectedDropPct: null,
      source: 'note',
      note: 'unconfirmed',
    },
  );
  const r = build(fx.dataset, 0, 'EV-T', null, { excludeUnverifiedProduction: true });
  const iv = r.intervals.find((x) => x.tsUtc === Date.parse('2026-08-18T20:00:00Z'))!;
  assert.equal(iv.productionVerifiedAnomaly, true);
  assert.equal(iv.productionUnverifiedAnomaly, true);
  assert.ok(iv.exclusionCodes.includes('production_unverified'));
});

test('a validation report is never a savings claim', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const r = buildReport({
    dataset: fx.dataset,
    site: fx.site,
    eventId: 'EV-T',
    revisionId: null,
    exclusions: mergeExclusions({ bootstrapReplicates: 200 }),
    taskId: 't',
    taskLabel: 'validation',
    scope: 'training_validation',
    validationDate: '2026-08-05',
    reportId: 'r-val',
    now: Date.parse('2026-09-11T00:00:00Z'),
    parentReportId: null,
    latestDatasetVersionId: fx.dataset.id,
  });
  assert.equal(r.status, 'training_only');
  assert.equal(r.claimable, false);
  assert.ok(r.notes.some((n) => n.includes('not a claim')));
});

test('mergeExclusions clamps hostile input', () => {
  const cfg = mergeExclusions({
    minActualCoverage: 42,
    lookbackDays: -900,
    bootstrapReplicates: 10 ** 9,
    excludeProductionStatuses: ['unplanned_shutdown', 'bogus_status', 7],
    autoPolicy: 'prefer_weather',
    methodOverride: 'nonsense',
  });
  assert.equal(cfg.minActualCoverage, 1);
  assert.equal(cfg.lookbackDays, 7);
  assert.equal(cfg.bootstrapReplicates, 5000);
  assert.deepEqual(cfg.excludeProductionStatuses, ['unplanned_shutdown']);
  assert.equal(cfg.autoPolicy, 'prefer_weather');
  assert.equal(cfg.methodOverride, null);
});
