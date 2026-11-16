/**
 * Build the demo dataset versions from the synthetic CSV bundle.
 *
 *   v1 = as-delivered files
 *   v2 = v1 + corrections_v2.csv (late backfill, production verification)
 *
 * Both versions are immutable JSON snapshots in data/store.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSyntheticDataset } from './lib/generator.js';
import { buildDataset } from '../src/ingest.js';
import type { DatasetVersion } from '../src/types.js';

export const DEMO_START = '2026-07-20';
export const DEMO_END = '2026-11-08';

const root = process.cwd();
const demoDir = join(root, 'data', 'demo-v1');
const storeDir = join(root, 'data', 'store');
mkdirSync(demoDir, { recursive: true });
mkdirSync(storeDir, { recursive: true });

console.log('Generating synthetic CSV bundle …');
writeSyntheticDataset({
  seed: 20260816,
  startDate: DEMO_START,
  endDate: DEMO_END,
  outDir: demoDir,
  manifestExtra: { label: 'Synthetic demo bundle', generatedBy: 'scripts/generate-demo.ts' },
});

const baseKinds = [
  ['sites.csv', 'sites'],
  ['stations.csv', 'stations'],
  ['interval_reads.csv', 'reads'],
  ['weather_hourly.csv', 'weather'],
  ['production_log.csv', 'production'],
  ['meter_registry.csv', 'meters'],
  ['dr_events.csv', 'events'],
  ['holidays.csv', 'holidays'],
] as const;

const read = (name: string) => readFileSync(join(demoDir, name), 'utf8');
const v1Sources = baseKinds.map(([name, kind]) => ({ name, kind, content: read(name) }));

const v1 = buildDataset(v1Sources, null, {
  id: 'ds-2026.08.10-a',
  label: 'Demo v1 — as delivered',
  createdAtUtc: '2026-08-10T09:12:00Z',
  sourceLabel: 'Synthetic demo bundle (seed 20260816)',
  notes: [
    'As-delivered interval, weather, production, meter, and event exports.',
    'The 2026-08-27 17:00–17:45 telemetry gap at SITE-RIV is still missing here.',
  ],
  analysisStartDate: DEMO_START,
  analysisEndDate: DEMO_END,
  asOfLabel: 'As of 2026-08-10 09:12 UTC',
});

const v2 = buildDataset(
  [...v1Sources, { name: 'corrections_v2.csv', kind: 'corrections', content: read('corrections_v2.csv') }],
  v1.dataset,
  {
    id: 'ds-2026.09.01-b',
    label: 'Demo v2 — backfill and production correction',
    createdAtUtc: '2026-09-01T17:40:00Z',
    sourceLabel: 'Synthetic demo bundle (seed 20260816) + corrections_v2',
    notes: [
      'Late logger backfill for the 2026-08-27 gap, flagged estimated.',
      'SITE-RIV 2026-08-20 production anomaly countersigned and now verified.',
    ],
    analysisStartDate: DEMO_START,
    analysisEndDate: DEMO_END,
    asOfLabel: 'As of 2026-09-01 17:40 UTC',
  },
);

writeFileSync(join(storeDir, 'dataset-v1.json'), JSON.stringify(v1.dataset));
writeFileSync(join(storeDir, 'dataset-v2.json'), JSON.stringify(v2.dataset));
writeFileSync(
  join(storeDir, 'versions.json'),
  JSON.stringify(
    // `builtAt` is the version's own timestamp, not the wall clock, so running
    // the generator twice produces byte-identical files (datasets are pinned).
    { latest: v2.dataset.id, order: [v1.dataset.id, v2.dataset.id], diff: v2.versionDiff, builtAt: v2.dataset.createdAtUtc },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(demoDir, 'README.txt'),
  [
    'Synthetic demonstration files. Not real utility, customer, or settlement data.',
    '',
    'interval_reads.csv    15-minute kWh, strict UTC timestamps, measured/estimated flag',
    'weather_hourly.csv    hourly dry-bulb and humidity per station',
    'production_log.csv    production/shutdown records with a verified flag',
    'meter_registry.csv    meter install/remove times (exchange at SITE-RIV 2026-08-11)',
    'dr_events.csv         dispatch revisions, UTC and site-local time bases',
    'holidays.csv          local holidays',
    'corrections_v2.csv    late backfill + production verification (v2 only)',
    '',
    `Dataset versions written to data/store: ${v1.dataset.id}, ${v2.dataset.id}`,
  ].join('\n') + '\n',
);

const summary = (ds: DatasetVersion) => ({
  id: ds.id,
  reads: ds.reads.length,
  weather: ds.weather.length,
  production: ds.production.length,
  events: ds.events.length,
  quarantined: ds.quarantine.length,
  quarantineCodes: ds.ingest.byCode,
});
console.log(JSON.stringify({ v1: summary(v1.dataset), v2: summary(v2.dataset), diff: v2.versionDiff }, null, 2));
