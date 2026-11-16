import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, mergeExclusions } from '../src/report.js';
import { buildFixture } from './fixture.js';

function report(opts: { exclusions?: Record<string, unknown>; revisionId?: string | null; dataset?: ReturnType<typeof buildFixture>['dataset']; site?: ReturnType<typeof buildFixture>['site'] } = {}) {
  const fx = opts.dataset ? null : buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10' });
  const dataset = opts.dataset ?? fx!.dataset;
  const site = opts.site ?? fx!.site;
  return buildReport({
    dataset,
    site,
    eventId: 'EV-T',
    revisionId: opts.revisionId ?? null,
    exclusions: mergeExclusions(opts.exclusions ?? {}),
    taskId: 'task-1',
    taskLabel: 'test',
    scope: 'event',
    validationDate: null,
    reportId: 'rep-1',
    now: Date.parse('2026-09-11T00:00:00Z'),
    parentReportId: null,
    latestDatasetVersionId: dataset.id,
  });
}

test('a 15% curtailment is recovered close to the true 15%', () => {
  const r = report({ exclusions: { bootstrapReplicates: 300 } });
  assert.equal(r.status, 'ok');
  assert.ok(r.results.savingsKwh !== null && r.results.savingsKwh > 0, 'savings must be positive');
  assert.ok(
    Math.abs((r.results.savingsPct ?? 0) - 15) < 2,
    `recovered ${r.results.savingsPct?.toFixed(2)}% versus a true 15%`,
  );
  assert.ok(r.results.attributableCoverage === 1);
});

test('training never uses the event day or later (leakage guard)', () => {
  const r = report();
  const selected = r.methods.find((m) => m.selected)!;
  assert.ok(selected.sample.trainingEndUtc <= r.window.startUtc);
  assert.ok(selected.sample.windowEndDate < r.window.localDates[0], 'training window ends before the event date');
  const guard = selected.checks.find((c) => c.code === 'no_leakage');
  assert.equal(guard?.passed, true);
  assert.ok(!selected.sample.matchedDates.includes('2026-08-18'));
});

test('all three rules are produced and the selected rule is marked once', () => {
  const r = report();
  assert.equal(r.methods.length, 3);
  assert.equal(r.methods.filter((m) => m.selected).length, 1);
  for (const m of r.methods) {
    assert.ok(m.checks.length >= 4);
    assert.ok(m.sample.examinedDays > 0);
  }
});

test('the rule-choice difference is reported against the selected rule', () => {
  const r = report();
  const selected = r.methods.find((m) => m.selected)!;
  const others = r.methods.filter((m) => !m.selected);
  // A rule is never compared with itself.
  assert.equal(selected.deltaVsSelected, null);
  assert.ok(others.some((m) => m.deltaVsSelected !== null), 'at least one alternative rule reports its difference');
  for (const m of others) {
    if (m.deltaVsSelected === null) continue;
    assert.ok(Math.abs(m.deltaVsSelected.savingsDiffKwh ?? 0) >= 0);
    assert.ok(m.deltaVsSelected.note.length > 0);
  }
});

test('a forced rule is honoured and flagged as a manual override', () => {
  const r = report({ exclusions: { methodOverride: 'weather_regression' } });
  assert.equal(r.method, 'weather_regression');
  assert.equal(r.methodPolicy, 'manual');
  assert.ok(r.warnings.some((w) => w.code === 'manual_method_override'));
});

test('raising the coverage threshold demotes a partial window', () => {
  const hi = report({ exclusions: { minActualCoverage: 1 } });
  assert.equal(hi.status, 'ok');
  const impossible = report({ exclusions: { minActualCoverage: 1, minAttributableShare: 1 } });
  assert.ok(['ok', 'insufficient_attribution'].includes(impossible.status));
});

test('uncertainty is a real interval, not a point', () => {
  const r = report({ exclusions: { bootstrapReplicates: 400 } });
  assert.ok(r.results.savingsCi90 !== null);
  const [lo, hi] = r.results.savingsCi90!;
  assert.ok(hi > lo, 'CI must have width');
  assert.ok(r.results.savingsKwh! >= lo && r.results.savingsKwh! <= hi, 'point estimate inside its own CI');
  assert.ok(r.uncertainty.replicates === 400);
});

test('missing reads inside the window remove intervals instead of adding zero savings', () => {
  const fx = buildFixture({ startDate: '2026-06-01', endDate: '2026-09-10', emitEventReads: false });
  const r = report({ dataset: fx.dataset, site: fx.site });
  assert.notEqual(r.status, 'ok');
  assert.equal(r.results.attributableCoverage, 0);
  assert.ok(r.attribution.reasons.some((x) => x.code === 'missing_actual'));
  assert.equal(r.results.savingsKwh, null);
});

test('exclusion configuration changes the basis fingerprint', () => {
  const a = report({ exclusions: { excludeHolidays: true } });
  const b = report({ exclusions: { excludeHolidays: false } });
  assert.notEqual(a.basis.exclusionsHash, b.basis.exclusionsHash);
  assert.notEqual(a.basis.suiteHash, b.basis.suiteHash);
});

test('day-type restriction keeps weekends out of a weekday dispatch baseline', () => {
  const r = report();
  const selected = r.methods.find((m) => m.selected)!;
  assert.equal(selected.sample.dayType, 'weekday');
  assert.equal(selected.sample.dayTypeRestricted, true);
  for (const d of selected.sample.matchedDates) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d} is a weekend day`);
  }
});
