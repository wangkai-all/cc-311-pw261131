import assert from 'node:assert/strict';
import test from 'node:test';
import { alignSite } from '../src/alignment.js';
import type { DatasetVersion, Meter, RawRead, Site } from '../src/types.js';

const SITE: Site = {
  id: 'SITE-A',
  name: 'Alpha',
  timezone: 'America/Chicago',
  segment: 'Test',
  floorAreaSqft: 1000,
  latitude: 41,
  longitude: -87,
  weatherStationId: 'WX-A',
  note: '',
};

function dataset(reads: RawRead[], meters: Meter[]): DatasetVersion {
  return {
    id: 'ds',
    label: 'ds',
    createdAtUtc: '2026-08-10T00:00:00Z',
    sourceLabel: 'test',
    notes: [],
    analysisStartDate: '2026-08-01',
    analysisEndDate: '2026-08-03',
    sites: [SITE],
    stations: [{ id: 'WX-A', name: 'A', city: 'A', note: '' }],
    meters,
    reads,
    weather: [],
    production: [],
    holidays: [],
    events: [],
    quarantine: [],
    ingest: {
      files: [],
      rawRows: reads.length,
      acceptedReads: reads.length,
      acceptedWeather: 0,
      quarantined: 0,
      byCode: {},
      duplicatesDropped: 0,
      outOfPeriodReads: 0,
      outOfPeriodWeather: 0,
      warnings: [],
      asOfLabel: 'test',
    },
    rawHash: 'x',
  };
}

const at = (s: string) => Date.parse(s);
const read = (meterId: string, iso: string, kwh: number): RawRead => ({ siteId: 'SITE-A', meterId, tsUtc: at(iso), kwh, quality: 'measured', rowRef: `${meterId}:${iso}` });
const meter = (id: string, installed: string, removed: string | null): Meter => ({
  id,
  siteId: 'SITE-A',
  serial: id,
  multiplier: 1,
  installedAtUtc: at(installed),
  removedAtUtc: removed ? at(removed) : null,
  note: '',
});

test('missing interval stays missing and is not zero-filled', () => {
  const ds = dataset(
    [
      read('M1', '2026-08-01T05:00:00Z', 1.0),
      read('M1', '2026-08-01T05:30:00Z', 1.2),
    ],
    [meter('M1', '2020-01-01T00:00:00Z', null)],
  );
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  const missing = day.intervals.find((iv) => iv.localTime === '00:15');
  assert.equal(missing?.status, 'missing');
  assert.equal(missing?.kwh, null);
  assert.ok(day.intervals.some((iv) => iv.status === 'ok' && iv.kwh === 1.0));
  assert.equal(day.presentIntervals, 2);
});

test('two active meters reporting the same interval is a conflict, never an average', () => {
  const ds = dataset(
    [
      read('M1', '2026-08-01T05:00:00Z', 10),
      read('M2', '2026-08-01T05:00:00Z', 9.5),
    ],
    [meter('M1', '2020-01-01T00:00:00Z', null), meter('M2', '2020-01-01T00:00:00Z', null)],
  );
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  const iv = day.intervals.find((x) => x.localTime === '00:00')!;
  assert.equal(iv.status, 'meter_conflict');
  assert.equal(iv.kwh, null);
  assert.equal(al.summary.conflict, 1);
});

test('a meter-exchange day flags the interval where both meters are active', () => {
  const ds = dataset(
    [
      read('M1', '2026-08-01T05:00:00Z', 10),
      read('M2', '2026-08-01T06:00:00Z', 11),
      read('M1', '2026-08-01T06:00:00Z', 10.8),
    ],
    [meter('M1', '2020-01-01T00:00:00Z', '2026-08-01T06:30:00Z'), meter('M2', '2026-08-01T05:30:00Z', null)],
  );
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  assert.equal(day.meterExchange, true);
  const overlap = day.intervals.find((x) => x.localTime === '01:00')!;
  assert.equal(overlap.status, 'meter_conflict');
});

test('a gap between meters leaves no active meter instead of synthesizing a reading', () => {
  const ds = dataset([read('M1', '2026-08-01T05:00:00Z', 3)], [
    meter('M1', '2020-01-01T00:00:00Z', '2026-08-01T05:30:00Z'),
    meter('M2', '2026-08-01T06:00:00Z', null),
  ]);
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  const gap = day.intervals.find((x) => x.localTime === '00:45')!;
  assert.equal(gap.status, 'no_active_meter');
  assert.equal(gap.kwh, null);
  assert.ok(al.summary.noActiveMeter > 0);
});

test('DST fall-back day carries 100 local slots and the repeated hour is present twice', () => {
  const ds = dataset([], [meter('M1', '2020-01-01T00:00:00Z', null)]);
  ds.sites = [{ ...SITE, timezone: 'America/New_York' }];
  ds.analysisStartDate = '2026-11-01';
  ds.analysisEndDate = '2026-11-01';
  const al = alignSite(ds, ds.sites[0]);
  const day = al.days.get('2026-11-01')!;
  assert.equal(day.intervals.length, 100);
  assert.equal(day.dstTransition, true);
  const ones = day.intervals.filter((iv) => iv.localTime === '01:00');
  assert.equal(ones.length, 2, 'the 01:00 wall-clock hour occurs twice');
  assert.notEqual(ones[0].offsetMinutes, ones[1].offsetMinutes);
});

test('readings from a meter outside its service period are rejected as invalid', () => {
  const ds = dataset([read('M1', '2026-08-01T05:00:00Z', 4)], [meter('M1', '2020-01-01T00:00:00Z', '2026-07-01T00:00:00Z')]);
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  const iv = day.intervals.find((x) => x.localTime === '00:00')!;
  // A read exists but no meter was registered at that instant: `invalid` (not a
  // silent zero, and not counted as a genuine no-meter gap).
  assert.equal(iv.status, 'invalid');
  assert.equal(iv.kwh, null);
  assert.ok(al.summary.invalid > 0);
});

test('weather is attached from the nearest observation and marked when derived', () => {
  const ds = dataset([read('M1', '2026-08-01T05:00:00Z', 4)], [meter('M1', '2020-01-01T00:00:00Z', null)]);
  ds.weather = [
    { stationId: 'WX-A', tsUtc: at('2026-08-01T04:00:00Z'), tempF: 70, humidityPct: 50, rowRef: 'w1' },
    { stationId: 'WX-A', tsUtc: at('2026-08-01T05:00:00Z'), tempF: 72, humidityPct: 50, rowRef: 'w2' },
  ];
  const al = alignSite(ds, SITE);
  const day = al.days.get('2026-08-01')!;
  const iv = day.intervals.find((x) => x.tsUtc === at('2026-08-01T05:00:00Z'))!;
  assert.equal(iv.tempF, 72);
  assert.equal(iv.tempSource, 'observed');
  const derived = day.intervals.find((x) => x.tsUtc === at('2026-08-01T06:30:00Z'))!;
  assert.equal(derived.tempSource, 'nearest');
  assert.equal(derived.tempF, 72);
  assert.ok(al.summary.intervals > 0);
});
