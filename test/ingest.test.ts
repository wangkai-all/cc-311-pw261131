import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataset } from '../src/ingest.js';

const SITES = [
  'site_id,name,timezone,segment,floor_area_sqft,latitude,longitude,weather_station_id,note',
  'SITE-A,Alpha,UTC,Test,1000,40,-90,WX-A,test site',
].join('\n');

const STATIONS = ['station_id,name,city,note', 'WX-A,Station A,A,test'].join('\n');

const METERS = [
  'meter_id,site_id,serial,multiplier,installed_utc,removed_utc,note',
  'M1,SITE-A,S1,1,2020-01-01T00:00:00Z,,first',
].join('\n');

const READS = [
  'site_id,meter_id,read_ts_utc,kwh,quality,note',
  'SITE-A,M1,2026-08-01T00:00:00Z,1.5,measured,ok',
  'SITE-A,M1,2026-08-01T00:15:00Z,1.6,measured,ok',
  'SITE-A,M1,2026-08-01T00:30:00Z,1.7,estimated,ok',
  // duplicate of the same (site, meter, instant)
  'SITE-A,M1,2026-08-01T00:30:00Z,1.8,measured,dup',
  // local timestamp without a zone: must be quarantined, never guessed
  'SITE-A,M1,2026-08-01 01:00,1.9,measured,no zone',
  // impossible time
  'SITE-A,M1,2026-02-31T00:00:00Z,2.0,measured,bad date',
  // negative and implausible values
  'SITE-A,M1,2026-08-01T01:15:00Z,-5,measured,negative',
  'SITE-A,M1,2026-08-01T01:30:00Z,99999,measured,implausible',
  // unknown meter
  'SITE-A,M9,2026-08-01T01:45:00Z,1.4,measured,unknown meter',
].join('\n');

const WEATHER = ['station_id,obs_ts_utc,temp_f,humidity_pct', 'WX-A,2026-08-01T00:00:00Z,80,40'].join('\n');
const PRODUCTION = ['site_id,start_utc,end_utc,status,verified,expected_drop_pct,source,note'].join('\n');
const HOLIDAYS = ['date,name,site_ids,note'].join('\n');
const EVENTS = [
  'event_id,revision,status,site_ids,time_basis,local_date,local_start,local_end,start_utc,end_utc,issued_at_utc,changes,note,cancellation_at_utc,cancellation_reason,supersedes_revision_id',
  'EV-1,1,completed,SITE-A,utc,,,2026-08-01T00:00:00Z,2026-08-01T01:00:00Z,2026-07-30T00:00:00Z,initial,test,,,,',
].join('\n');

function build(reads = READS, extra: { name: string; kind: string; content: string }[] = []) {
  return buildDataset(
    [
      { name: 'sites.csv', kind: 'sites', content: SITES },
      { name: 'stations.csv', kind: 'stations', content: STATIONS },
      { name: 'meters.csv', kind: 'meters', content: METERS },
      { name: 'reads.csv', kind: 'reads', content: reads },
      { name: 'weather.csv', kind: 'weather', content: WEATHER },
      { name: 'production.csv', kind: 'production', content: PRODUCTION },
      { name: 'holidays.csv', kind: 'holidays', content: HOLIDAYS },
      { name: 'events.csv', kind: 'events', content: EVENTS },
      ...extra,
    ],
    null,
    {
      id: 'ds-test',
      label: 'test',
      createdAtUtc: '2026-08-02T00:00:00Z',
      sourceLabel: 'unit test',
      notes: [],
      analysisStartDate: '2026-08-01',
      analysisEndDate: '2026-08-02',
      asOfLabel: 'as of test',
    },
  );
}

test('good rows are accepted and bad rows are quarantined with codes', () => {
  const { dataset } = build();
  assert.equal(dataset.reads.length, 3, 'the three valid reads survive; the duplicate keeps the first');
  assert.equal(dataset.reads.find((r) => r.quality === 'estimated')?.kwh, 1.7, 'quality flag is preserved, not rewritten');
  const codes = dataset.quarantine.map((q) => q.code);
  assert.ok(codes.includes('read_duplicate'), `expected read_duplicate, got ${codes.join(',')}`);
  assert.equal(codes.filter((c) => c === 'read_bad_timestamp').length, 2, 'both the zone-less and the impossible date are rejected');
  assert.ok(codes.includes('read_unknown_meter'));
  assert.ok(codes.includes('read_negative'));
  assert.ok(codes.includes('read_absurd'));
  // Quarantine never turns a bad row into a zero reading.
  assert.ok(dataset.reads.every((r) => r.kwh > 0));
});

test('quarantine summary counts match the rows', () => {
  const { dataset } = build();
  const total = Object.values(dataset.ingest.byCode).reduce((a, b) => a + b, 0);
  assert.equal(total, dataset.quarantine.length);
  assert.equal(dataset.ingest.files.length, 8);
});

test('a corrections file creates a new version and a diff, without mutating the base', () => {
  const v1 = build();
  const corrections = [
    'kind,site_id,start_utc,read_ts_utc,kwh,quality,field,new_value,note',
    'read,SITE-A,,2026-08-01T00:00:00Z,9.9,measured,,,corrected',
  ].join('\n');
  const v2 = buildDataset(
    [
      { name: 'sites.csv', kind: 'sites', content: SITES },
      { name: 'stations.csv', kind: 'stations', content: STATIONS },
      { name: 'meters.csv', kind: 'meters', content: METERS },
      { name: 'reads.csv', kind: 'reads', content: READS },
      { name: 'weather.csv', kind: 'weather', content: WEATHER },
      { name: 'production.csv', kind: 'production', content: PRODUCTION },
      { name: 'holidays.csv', kind: 'holidays', content: HOLIDAYS },
      { name: 'events.csv', kind: 'events', content: EVENTS },
      { name: 'corrections.csv', kind: 'corrections', content: corrections },
    ],
    v1.dataset,
    {
      id: 'ds-test-v2',
      label: 'test v2',
      createdAtUtc: '2026-08-03T00:00:00Z',
      sourceLabel: 'unit test',
      notes: [],
      analysisStartDate: '2026-08-01',
      analysisEndDate: '2026-08-02',
      asOfLabel: 'as of test',
    },
  );
  assert.equal(v1.dataset.reads.find((r) => r.tsUtc === Date.parse('2026-08-01T00:00:00Z'))?.kwh, 1.5);
  assert.equal(v2.dataset.reads.find((r) => r.tsUtc === Date.parse('2026-08-01T00:00:00Z'))?.kwh, 9.9);
  assert.equal(v2.versionDiff?.correctedReads, 1);
  assert.equal(v2.versionDiff?.fromVersionId, 'ds-test');
});

test('dataset fingerprint changes when content changes and is stable otherwise', () => {
  const a = build();
  const b = build();
  assert.equal(a.dataset.rawHash, b.dataset.rawHash);
  const c = build(READS.replace('1.5,measured', '1.55,measured'));
  assert.notEqual(a.dataset.rawHash, c.dataset.rawHash);
});
