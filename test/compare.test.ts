import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, mergeExclusions } from '../src/report.js';
import { compareReports, reportCsv, summarizeReport } from '../src/compare.js';
import { buildFixture } from './fixture.js';

function mk(opts: {
  fx?: ReturnType<typeof buildFixture>;
  datasetId?: string;
  revisionId?: string | null;
  exclusions?: Record<string, unknown>;
  reportId?: string;
  scenario?: 'base' | 'corrected' | 'moved';
}) {
  const fx = opts.fx ?? buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const ds = fx.dataset;
  if (opts.datasetId) ds.id = opts.datasetId;
  if (opts.scenario === 'corrected') {
    // Revise the event-day reads upward: a late correction.
    for (const r of ds.reads) {
      if (r.tsUtc >= Date.parse('2026-08-18T20:00:00Z') && r.tsUtc < Date.parse('2026-08-18T23:00:00Z')) r.kwh *= 1.1;
    }
  }
  if (opts.scenario === 'moved') {
    const rev = ds.events[0].revisions[0];
    rev.id = 'EV-T-r2';
    rev.revision = 2;
    rev.startUtc = Date.parse('2026-08-18T21:00:00Z');
    rev.endUtc = Date.parse('2026-08-18T23:00:00Z');
    rev.siteWindows = [{ siteId: fx.site.id, startUtc: rev.startUtc, endUtc: rev.endUtc }];
    rev.supersedesRevisionId = 'EV-T-r1';
  }
  return buildReport({
    dataset: ds,
    site: fx.site,
    eventId: fx.eventId,
    revisionId: opts.revisionId ?? null,
    exclusions: mergeExclusions({ bootstrapReplicates: 150, ...(opts.exclusions ?? {}) }),
    taskId: 't',
    taskLabel: 'x',
    scope: 'event',
    validationDate: null,
    reportId: opts.reportId ?? 'rep',
    now: Date.parse('2026-09-11T00:00:00Z'),
    parentReportId: null,
    latestDatasetVersionId: ds.id,
  });
}

test('identical reports compare exactly with zero deltas', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const a = mk({ fx, reportId: 'a' });
  const b = mk({ fx, reportId: 'b' });
  const c = compareReports({ a, b });
  assert.equal(c.comparability, 'exact');
  assert.equal(c.comparable, true);
  assert.equal(c.mismatches.length, 0);
  assert.equal(c.deltas?.savingsKwh, 0);
  assert.equal(c.deltas?.baselineKwh, 0);
  assert.ok(c.commonWindow !== null);
});

test('a new dataset version is a revision-level comparison, not an exact one', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const a = mk({ fx, datasetId: 'ds-v1', reportId: 'a' });
  const b = mk({ fx, datasetId: 'ds-v2', scenario: 'corrected', reportId: 'b' });
  const c = compareReports({ a, b });
  assert.equal(c.comparability, 'revision');
  assert.ok(c.mismatches.some((m) => m.field === 'datasetVersionId'));
  assert.ok(c.deltas !== null);
  assert.ok((c.deltas!.savingsKwh ?? 0) !== 0, 'the correction changes savings');
  assert.ok(c.commonWindow !== null);
});

test('a moved revision reports the mismatch and still gives a common-window delta', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const a = mk({ fx, reportId: 'a' });
  const b = mk({ fx, scenario: 'moved', revisionId: 'EV-T-r2', reportId: 'b' });
  const c = compareReports({ a, b });
  assert.equal(c.comparability, 'revision');
  assert.ok(c.mismatches.some((m) => m.field === 'eventRevisionId'));
  assert.ok(c.mismatches.some((m) => m.field === 'windowHash'));
  const cw = c.commonWindow!;
  assert.ok(cw !== null);
  assert.equal(cw.startUtc, Math.max(a.window.startUtc, b.window.startUtc));
  assert.equal(cw.endUtc, Math.min(a.window.endUtc, b.window.endUtc));
  assert.equal(cw.intervals, 8, 'the overlap is 21:00–23:00, eight intervals');
  assert.ok(cw.deltaSavingsKwh !== null);
});

test('different exclusion settings are flagged and block an exact comparison', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const a = mk({ fx, reportId: 'a', exclusions: { excludeHolidays: true } });
  const b = mk({ fx, reportId: 'b', exclusions: { excludeHolidays: false } });
  const c = compareReports({ a, b });
  assert.equal(c.comparability, 'method');
  assert.ok(c.mismatches.some((m) => m.field === 'exclusionsHash'));
  assert.ok(c.notes.some((n) => n.includes('different exclusion')));
});

test('different sites are incomparable and produce no delta', () => {
  const fx1 = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10', siteId: 'SITE-A' });
  const fx2 = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10', siteId: 'SITE-B' });
  const a = mk({ fx: fx1, reportId: 'a' });
  const b = mk({ fx: fx2, reportId: 'b' });
  const c = compareReports({ a, b });
  assert.equal(c.comparable, false);
  assert.equal(c.comparability, 'incomparable');
  assert.equal(c.deltas, null);
  assert.ok(c.mismatches.some((m) => m.severity === 'critical'));
});

test('reports whose windows do not overlap have no common-window delta', () => {
  const fx = buildFixture({
    startDate: '2026-06-01',
    endDate: '2026-09-10',
  });
  const a = mk({ fx, reportId: 'a' });
  // Build a second fixture with a dispatch at a different date.
  const fx2 = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10', eventDate: '2026-07-07' });
  fx2.dataset.sites[0].id = fx.site.id;
  fx2.dataset.sites[0].name = fx.site.name;
  const b = mk({ fx: fx2, reportId: 'b' });
  const c = compareReports({ a, b });
  assert.equal(c.commonWindow, null);
});

test('report CSV has one row per interval plus a header and no invented values', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const r = mk({ fx });
  const csv = reportCsv(r);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, r.intervals.length + 1);
  assert.ok(lines[0].startsWith('index,ts_utc,local_date'));
  const missing = r.intervals.filter((iv) => iv.actualKwh === null);
  for (const iv of missing) {
    const line = lines.find((l) => l.startsWith(`${iv.index},`))!;
    const cells = line.split(',');
    assert.equal(cells[9], '', 'a missing actual must be empty, never 0');
  }
});

test('report summaries carry the basis needed to pick a comparison', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const r = mk({ fx });
  const s = summarizeReport(r);
  assert.equal(s.id, r.id);
  assert.equal(s.exclusionsHash, r.basis.exclusionsHash);
  assert.equal(s.savingsKwh, r.results.savingsKwh);
  assert.equal(s.windowStartUtc, r.window.startUtc);
});
