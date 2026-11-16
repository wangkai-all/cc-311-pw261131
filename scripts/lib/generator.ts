/**
 * Synthetic dataset generator.
 *
 * Everything is deterministic from the seed. Output is CSV text only; the
 * dataset builder performs parsing/validation so the same code path is used for
 * generated files and any user-uploaded files.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { addDays, enumerateDates, isWeekendDate, localWallToUtc, parseDateStr } from '../../src/time.js';
import { makeRng, normalRng, round } from '../../src/util.js';

interface SiteSpec {
  id: string;
  name: string;
  timezone: string;
  segment: string;
  floorAreaSqft: number;
  latitude: number;
  longitude: number;
  weatherStationId: string;
  baseKw: number;
  tempSensitivityKwPerF: number;
  productionShare: number;
  weekdayProfile: number[];
  noiseSd: number;
  dispatch: 'shed' | 'precool' | 'preheat';
  note: string;
}

interface StationSpec {
  id: string;
  name: string;
  city: string;
  baseTemp: number;
  ampSeason: number;
  noiseSd: number;
  humidityBase: number;
  note: string;
}

const SITES: SiteSpec[] = [
  {
    id: 'SITE-RIV',
    name: 'Riverside Foods Plant',
    timezone: 'America/Chicago',
    segment: 'Food & Beverage',
    floorAreaSqft: 184000,
    latitude: 41.87,
    longitude: -87.65,
    weatherStationId: 'WX-CHI',
    baseKw: 520,
    tempSensitivityKwPerF: 13.0,
    productionShare: 0.76,
    weekdayProfile: [0.52, 0.9, 1.0, 0.99, 0.97, 0.86, 0.55],
    noiseSd: 7.5,
    dispatch: 'precool',
    note: 'Two-shift refrigerated plant; one utility interval meter, 15-minute reads.',
  },
  {
    id: 'SITE-ARD',
    name: 'Arden Cold Storage',
    timezone: 'America/New_York',
    segment: 'Cold Storage',
    floorAreaSqft: 132000,
    latitude: 40.28,
    longitude: -74.86,
    weatherStationId: 'WX-NYC',
    baseKw: 385,
    tempSensitivityKwPerF: 10.5,
    productionShare: 0.68,
    weekdayProfile: [0.6, 0.88, 0.98, 0.99, 0.95, 0.82, 0.58],
    noiseSd: 6.0,
    dispatch: 'preheat',
    note: 'Cold storage and blast freezing; six compressors. Meter reads have an estimated-read period.',
  },
  {
    id: 'SITE-GLN',
    name: 'Glenview Plastics',
    timezone: 'America/Denver',
    segment: 'Plastics',
    floorAreaSqft: 98000,
    latitude: 39.74,
    longitude: -105.0,
    weatherStationId: 'WX-DEN',
    baseKw: 290,
    tempSensitivityKwPerF: 8.2,
    productionShare: 0.82,
    weekdayProfile: [0.55, 0.92, 1.0, 0.98, 0.94, 0.78, 0.5],
    noiseSd: 5.2,
    dispatch: 'shed',
    note: 'Injection molding; two presses, weekend idle.',
  },
  {
    id: 'SITE-MTN',
    name: 'Mountain View Logistics',
    timezone: 'America/Phoenix',
    segment: 'Logistics',
    floorAreaSqft: 260000,
    latitude: 33.45,
    longitude: -112.07,
    weatherStationId: 'WX-PHX',
    baseKw: 240,
    tempSensitivityKwPerF: 6.4,
    productionShare: 0.58,
    weekdayProfile: [0.66, 0.9, 0.97, 0.99, 0.96, 0.86, 0.7],
    noiseSd: 5.8,
    dispatch: 'shed',
    note: 'Distribution center; no daylight-saving transitions in this zone.',
  },
];

const STATIONS: StationSpec[] = [
  { id: 'WX-CHI', name: 'Chicago O’Hare', city: 'Chicago', baseTemp: 46, ampSeason: 24, noiseSd: 2.1, humidityBase: 62, note: 'Regional airport station; hourly dry-bulb and humidity. Complete record.' },
  { id: 'WX-NYC', name: 'New York LaGuardia', city: 'New York', baseTemp: 50, ampSeason: 22, noiseSd: 1.9, humidityBase: 66, note: 'Coastal station; hourly observations interrupted 2026-08-23 through 2026-08-25.' },
  { id: 'WX-DEN', name: 'Denver International', city: 'Denver', baseTemp: 43, ampSeason: 21, noiseSd: 3.0, humidityBase: 48, note: 'High-altitude station; wide diurnal swing.' },
  { id: 'WX-PHX', name: 'Phoenix Sky Harbor', city: 'Phoenix', baseTemp: 66, ampSeason: 20, noiseSd: 2.4, humidityBase: 35, note: 'Desert station; no daylight-saving transitions.' },
];

interface EventDef {
  id: string;
  name: string;
  program: string;
  revisions: {
    revision: number;
    status: 'scheduled' | 'active' | 'completed' | 'cancelled';
    siteIds: string[];
    timeBasis: 'utc' | 'site_local';
    localDate: string | null;
    localStart: string | null;
    localEnd: string | null;
    startUtc: string | null;
    endUtc: string | null;
    issuedAtUtc: string;
    changes: string;
    cancellationAtUtc: string | null;
    cancellationReason: string | null;
    note: string;
    curtailsLoad: boolean;
  }[];
}

export const DEMO_EVENTS: EventDef[] = [
  {
    id: 'EV-2026-08-18',
    name: 'August Dispatch 2026-08-18',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-RIV'],
        timeBasis: 'site_local',
        localDate: '2026-08-18',
        localStart: '15:00',
        localEnd: '18:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-08-17T22:10:00Z',
        changes: 'Initial dispatch',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Three-hour afternoon event; hot and dry, strong weather response in the afternoon load.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-08-20',
    name: 'Joint Dispatch 2026-08-20',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-RIV', 'SITE-ARD'],
        timeBasis: 'site_local',
        localDate: '2026-08-20',
        localStart: '15:00',
        localEnd: '18:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-08-19T21:40:00Z',
        changes: 'Initial dispatch to two sites',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Arden suffered a compressor failure that same morning; its measured drop is production, not response.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-08-21-UTC',
    name: 'Reliability Dispatch 2026-08-21 (UTC basis)',
    program: 'Reliability DR (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-MTN'],
        timeBasis: 'utc',
        localDate: null,
        localStart: null,
        localEnd: null,
        startUtc: '2026-08-21T23:00:00Z',
        endUtc: '2026-08-22T01:30:00Z',
        issuedAtUtc: '2026-08-21T14:05:00Z',
        changes: 'Initial dispatch, times stated in UTC',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Specified in UTC; in America/Phoenix this is 16:00–18:30 on 2026-08-21.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-08-25',
    name: 'Afternoon Dispatch 2026-08-25',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-GLN'],
        timeBasis: 'site_local',
        localDate: '2026-08-25',
        localStart: '16:00',
        localEnd: '19:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-08-24T20:15:00Z',
        changes: 'Initial dispatch',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Plant lost its feeder at 08:00 and restarted at 20:00; the response window sits inside a verified outage.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-08-27',
    name: 'Heat Wave Dispatch 2026-08-27',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-RIV'],
        timeBasis: 'site_local',
        localDate: '2026-08-27',
        localStart: '16:00',
        localEnd: '19:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-08-26T19:30:00Z',
        changes: 'Initial dispatch; river intake temperature forecast 92F',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Primary demonstration case. One 45-minute telemetry gap falls inside the window.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-09-02-CANCELLED',
    name: 'Labour Day Dispatch 2026-09-02 (cancelled)',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'scheduled',
        siteIds: ['SITE-RIV'],
        timeBasis: 'site_local',
        localDate: '2026-09-02',
        localStart: '15:00',
        localEnd: '18:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-09-01T16:00:00Z',
        changes: 'Initial dispatch',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Issued on 2026-09-01 and withdrawn the same afternoon.',
        curtailsLoad: false,
      },
      {
        revision: 2,
        status: 'cancelled',
        siteIds: ['SITE-RIV'],
        timeBasis: 'site_local',
        localDate: '2026-09-02',
        localStart: '15:00',
        localEnd: '18:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-09-01T20:40:00Z',
        changes: 'Cancelled; no response expected',
        cancellationAtUtc: '2026-09-01T20:45:00Z',
        cancellationReason: 'Forecast load relief no longer needed; system conditions normal.',
        note: 'Cancellation revision supersedes dispatch revision 1.',
        curtailsLoad: false,
      },
    ],
  },
  {
    id: 'EV-2026-09-16-RESCHED',
    name: 'Rescheduled Dispatch 2026-09-16',
    program: 'Commercial DR Pilot (2026)',
    revisions: [
      {
        revision: 1,
        status: 'active',
        siteIds: ['SITE-ARD'],
        timeBasis: 'site_local',
        localDate: '2026-09-16',
        localStart: '14:00',
        localEnd: '17:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-09-15T19:00:00Z',
        changes: 'Initial dispatch 14:00–17:00',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Superseded by revision 2 with a two-hour shift.',
        curtailsLoad: false,
      },
      {
        revision: 2,
        status: 'completed',
        siteIds: ['SITE-ARD'],
        timeBasis: 'site_local',
        localDate: '2026-09-16',
        localStart: '16:00',
        localEnd: '19:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-09-16T00:20:00Z',
        changes: 'Window shifted +2h at PJM instruction',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Completed revision. Compare against revision 1 shows the interval impact of the shift.',
        curtailsLoad: true,
      },
    ],
  },
  {
    id: 'EV-2026-11-01-DST',
    name: 'Fall-Back Morning Dispatch 2026-11-01',
    program: 'Reliability DR (2026)',
    revisions: [
      {
        revision: 1,
        status: 'completed',
        siteIds: ['SITE-ARD'],
        timeBasis: 'site_local',
        localDate: '2026-11-01',
        localStart: '01:00',
        localEnd: '02:00',
        startUtc: null,
        endUtc: null,
        issuedAtUtc: '2026-10-31T21:00:00Z',
        changes: 'Initial dispatch across the DST fall-back hour',
        cancellationAtUtc: null,
        cancellationReason: null,
        note: 'Local label is one wall-clock hour, but 01:00–02:00 on the fall-back day spans two real hours (01:00 EDT → 02:00 EST).',
        curtailsLoad: true,
      },
    ],
  },
];

interface ProductionDef {
  siteId: string;
  start: [string, string];
  end: [string, string];
  status: string;
  verified: boolean;
  expectedDropPct: number | null;
  source: string;
  note: string;
}

const PRODUCTION: ProductionDef[] = [
  {
    siteId: 'SITE-RIV',
    start: ['2026-08-05', '05:00'],
    end: ['2026-08-09', '18:00'],
    status: 'planned_maintenance',
    verified: true,
    expectedDropPct: 62,
    source: 'CMMS work order WO-4482',
    note: 'Annual boiler and ammonia loop maintenance; both shifts down.',
  },
  {
    siteId: 'SITE-RIV',
    start: ['2026-08-20', '10:00'],
    end: ['2026-08-20', '16:00'],
    status: 'non_routine',
    verified: false,
    expectedDropPct: null,
    source: 'Night-shift supervisor note (unconfirmed)',
    note: 'Possible packaging line jam. Unverified; does not by itself drive exclusion.',
  },
  {
    siteId: 'SITE-RIV',
    start: ['2026-08-27', '06:00'],
    end: ['2026-08-27', '12:00'],
    status: 'non_routine',
    verified: true,
    expectedDropPct: 30,
    source: 'Shift report signed by plant engineer',
    note: 'Line changeover ran long; verified reduction before the dispatch window.',
  },
  {
    siteId: 'SITE-ARD',
    start: ['2026-08-20', '06:00'],
    end: ['2026-08-21', '22:00'],
    status: 'unplanned_shutdown',
    verified: true,
    expectedDropPct: 88,
    source: 'BMS alarm log + shift report',
    note: 'Compressor bank failure; plant offline through the response window.',
  },
  {
    siteId: 'SITE-ARD',
    start: ['2026-08-26', '07:00'],
    end: ['2026-08-27', '19:00'],
    status: 'reduced',
    verified: true,
    expectedDropPct: 35,
    source: 'Production plan revision',
    note: 'Single-line operation after an order cancellation.',
  },
  {
    siteId: 'SITE-GLN',
    start: ['2026-08-25', '08:00'],
    end: ['2026-08-25', '20:00'],
    status: 'unplanned_shutdown',
    verified: true,
    expectedDropPct: 80,
    source: 'Utility outage ticket + shift log',
    note: 'Feeder breaker trip on the press line; plant restarted at 20:00.',
  },
  {
    siteId: 'SITE-GLN',
    start: ['2026-08-12', '00:00'],
    end: ['2026-08-13', '00:00'],
    status: 'planned_maintenance',
    verified: true,
    expectedDropPct: 45,
    source: 'CMMS work order WO-4510',
    note: 'Chiller maintenance, half plant load.',
  },
  {
    siteId: 'SITE-MTN',
    start: ['2026-08-19', '00:00'],
    end: ['2026-08-19', '12:00'],
    status: 'reduced',
    verified: true,
    expectedDropPct: 28,
    source: 'Labor schedule',
    note: 'Partial shift, fewer forklifts.',
  },
];

interface MeterDef {
  id: string;
  siteId: string;
  serial: string;
  multiplier: number;
  installedLocal: [string, string];
  removedLocal: [string, string] | null;
  note: string;
}

const METERS: MeterDef[] = [
  { id: 'M-RIV-1', siteId: 'SITE-RIV', serial: 'SN-884120', multiplier: 1, installedLocal: ['2025-01-01', '00:00'], removedLocal: ['2026-08-11', '10:05'], note: 'Original meter; removed during a service upgrade.' },
  { id: 'M-RIV-2', siteId: 'SITE-RIV', serial: 'SN-884577', multiplier: 1, installedLocal: ['2026-08-11', '09:20'], removedLocal: null, note: 'Replacement meter installed during the upgrade; 45-minute overlap with the old meter.' },
  { id: 'M-ARD-1', siteId: 'SITE-ARD', serial: 'SN-771300', multiplier: 1, installedLocal: ['2025-01-01', '00:00'], removedLocal: null, note: 'Primary utility meter.' },
  { id: 'M-GLN-1', siteId: 'SITE-GLN', serial: 'SN-660941', multiplier: 1, installedLocal: ['2025-01-01', '00:00'], removedLocal: ['2026-09-03', '08:00'], note: 'Primary utility meter; pulled for a CT cabinet service.' },
  { id: 'M-GLN-2', siteId: 'SITE-GLN', serial: 'SN-660942', multiplier: 1, installedLocal: ['2026-09-03', '08:30'], removedLocal: null, note: 'Replacement meter after the CT cabinet service; 30-minute gap with no active meter.' },
  { id: 'M-MTN-1', siteId: 'SITE-MTN', serial: 'SN-552018', multiplier: 1, installedLocal: ['2025-01-01', '00:00'], removedLocal: null, note: 'Primary utility meter.' },
];

export interface GeneratorOptions {
  seed: number;
  startDate: string;
  endDate: string;
}

export interface GeneratedDataset {
  files: { name: string; kind: string; content: string; sha256: string; rows: number }[];
}

function siteTz(siteId: string): string {
  return SITES.find((s) => s.id === siteId)!.timezone;
}

function weekdayOf(date: string): number {
  const { y, m, d } = parseDateStr(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function csv(rows: Array<Array<string | number | boolean | null>>): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          if (v === null) return '';
          const s = String(v);
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n') + '\n';
}

function iso(ts: number): string {
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

/** Resolve a revision for one site; returns UTC bounds and local labels. */
export function resolveRevisionWindow(
  rev: EventDef['revisions'][number],
  timeZone: string,
): { startUtc: number; endUtc: number } {
  if (rev.timeBasis === 'utc') {
    return { startUtc: Date.parse(rev.startUtc!), endUtc: Date.parse(rev.endUtc!) };
  }
  return {
    startUtc: localWallToUtc(rev.localDate!, rev.localStart!, timeZone),
    endUtc: localWallToUtc(rev.localDate!, rev.localEnd!, timeZone),
  };
}

/** Regional heat wave around the dispatch week; dispatches happen when it is hot. */
const HEAT_WAVE = { from: '2026-08-14', to: '2026-09-04', bumpF: 8 };

/** Days on which dispatches happened are among the hottest of the study. */
const DISPATCH_DAYS = new Set(['2026-08-18', '2026-08-20', '2026-08-21', '2026-08-25', '2026-08-27', '2026-09-16']);

function tempAt(spec: StationSpec, date: string, hour: number, bias: number, rng: () => number): number {
  const { y, m, d } = parseDateStr(date);
  const doy = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000);
  const season = Math.cos((2 * Math.PI * (doy - 15)) / 365);
  const diurnal = -Math.cos((2 * Math.PI * ((hour - 3 + 24) % 24)) / 24);
  const heat = (date >= HEAT_WAVE.from && date <= HEAT_WAVE.to ? HEAT_WAVE.bumpF : 0) + (DISPATCH_DAYS.has(date) ? 4 : 0);
  return spec.baseTemp - spec.ampSeason * season + 8 * diurnal + heat + bias + (rng() - 0.5) * spec.noiseSd * 2;
}

interface MissingRule {
  code: string;
  siteId: string | null;
  localDate: string;
  fromHour: number;
  toHour: number;
}

const MISSING: MissingRule[] = [
  { code: 'telemetry_gap', siteId: 'SITE-RIV', localDate: '2026-08-27', fromHour: 17, toHour: 17.75 },
  { code: 'telemetry_gap', siteId: null, localDate: '2026-08-30', fromHour: 10, toHour: 11 },
  { code: 'telemetry_gap', siteId: 'SITE-GLN', localDate: '2026-08-09', fromHour: 0, toHour: 6 },
  { code: 'telemetry_gap', siteId: 'SITE-MTN', localDate: '2026-10-14', fromHour: 13, toHour: 17 },
];

const ESTIMATED: MissingRule[] = [
  { code: 'estimated_read', siteId: 'SITE-ARD', localDate: '2026-08-14', fromHour: 0, toHour: 24 },
  { code: 'estimated_read', siteId: 'SITE-MTN', localDate: '2026-09-08', fromHour: 8, toHour: 12 },
];

export function generateSyntheticDataset(opts: GeneratorOptions): GeneratedDataset {
  const rng = makeRng(opts.seed);
  const noise = normalRng(opts.seed ^ 0x9e3779b9);
  const dates = enumerateDates(opts.startDate, opts.endDate);

  // Station daily anomaly shared by all hours of a day.
  const dayBias = new Map<string, number>();
  for (const st of STATIONS) {
    for (const d of dates) {
      // Dispatch days are chosen as forecast heat days, so give them a positive
      // anomaly; other days get symmetric weather noise.
      dayBias.set(`${st.id}:${d}`, DISPATCH_DAYS.has(d) ? 1.5 + Math.abs(noise()) * 1.2 : noise() * 3.0);
    }
  }

  // ---------- sites / stations ----------
  const siteRows: Array<Array<string | number>> = [
    ['site_id', 'name', 'timezone', 'segment', 'floor_area_sqft', 'latitude', 'longitude', 'weather_station_id', 'note'],
    ...SITES.map((s) => [s.id, s.name, s.timezone, s.segment, s.floorAreaSqft, s.latitude, s.longitude, s.weatherStationId, s.note]),
  ];
  const stationRows: Array<Array<string | number>> = [
    ['station_id', 'name', 'city', 'note'],
    ...STATIONS.map((s) => [s.id, s.name, s.city, s.note]),
  ];

  // ---------- weather ----------
  const weatherRows: Array<Array<string | number | null>> = [
    ['station_id', 'obs_ts_utc', 'temp_f', 'humidity_pct'],
  ];
  for (const st of STATIONS) {
    for (const date of dates) {
      const bias = dayBias.get(`${st.id}:${date}`) ?? 0;
      if (st.id === 'WX-NYC' && date >= '2026-08-23' && date <= '2026-08-25') continue;
      for (let h = 0; h < 24; h++) {
        const { y, m, d } = parseDateStr(date);
        const tsUtc = Date.UTC(y, m - 1, d, h);
        if (st.id === 'WX-PHX' && date === '2026-09-12' && h >= 6 && h < 12) continue;
        const t = tempAt(st, date, h, bias, rng);
        const rh = st.humidityBase + 12 * Math.cos((2 * Math.PI * (h - 5)) / 24) + (rng() - 0.5) * 6;
        weatherRows.push([st.id, iso(tsUtc), round(t, 2), round(Math.min(99, Math.max(8, rh)), 1)]);
      }
    }
  }

  // ---------- production ----------
  const prodRows: Array<Array<string | number | boolean | null>> = [
    ['site_id', 'start_utc', 'end_utc', 'status', 'verified', 'expected_drop_pct', 'source', 'note'],
  ];
  const prodUtc = PRODUCTION.map((p) => {
    const tz = siteTz(p.siteId);
    return {
      ...p,
      startUtc: localWallToUtc(p.start[0], p.start[1], tz),
      endUtc: localWallToUtc(p.end[0], p.end[1], tz),
    };
  });
  for (const p of prodUtc) {
    prodRows.push([p.siteId, iso(p.startUtc), iso(p.endUtc), p.status, p.verified, p.expectedDropPct, p.source, p.note]);
  }

  // ---------- meters ----------
  const meterRows: Array<Array<string | number | null>> = [
    ['meter_id', 'site_id', 'serial', 'multiplier', 'installed_utc', 'removed_utc', 'note'],
  ];
  for (const m of METERS) {
    const tz = siteTz(m.siteId);
    meterRows.push([
      m.id,
      m.siteId,
      m.serial,
      m.multiplier,
      iso(localWallToUtc(m.installedLocal[0], m.installedLocal[1], tz)),
      m.removedLocal ? iso(localWallToUtc(m.removedLocal[0], m.removedLocal[1], tz)) : null,
      m.note,
    ]);
  }

  // ---------- reads ----------
  const readRows: Array<Array<string | number | null>> = [
    ['site_id', 'meter_id', 'read_ts_utc', 'kwh', 'quality', 'row_ref'],
  ];

  for (const site of SITES) {
    const tz = site.timezone;
    const station = STATIONS.find((s) => s.id === site.weatherStationId)!;
    const siteMeters = METERS.filter((m) => m.siteId === site.id).map((m) => ({
      id: m.id,
      installed: localWallToUtc(m.installedLocal[0], m.installedLocal[1], tz),
      removed: m.removedLocal ? localWallToUtc(m.removedLocal[0], m.removedLocal[1], tz) : Infinity,
    }));
    const eventWindows = DEMO_EVENTS.flatMap((e) =>
      e.revisions
        .filter((r) => r.curtailsLoad && r.siteIds.includes(site.id))
        .map((r) => ({ ...resolveRevisionWindow(r, tz), missingBackfill: e.id === 'EV-2026-08-27' })),
    );
    for (const date of dates) {
      const dow = weekdayOf(date);
      const weekend = isWeekendDate(date);
      const bias = dayBias.get(`${station.id}:${date}`) ?? 0;
      const dayProfile = site.weekdayProfile[dow] * (weekend ? 0.94 : 1);
      for (let slot = 0; slot < 96; slot++) {
        const hh = Math.floor(slot / 4);
        const mm = (slot % 4) * 15;
        const tsUtc = localWallToUtc(date, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz);
        const activeMeters = siteMeters.filter((m) => tsUtc >= m.installed && tsUtc < m.removed);
        if (activeMeters.length === 0) continue;

        const missing = MISSING.some(
          (r) => r.localDate === date && (r.siteId === null || r.siteId === site.id) && slot / 4 >= r.fromHour && slot / 4 < r.toHour,
        );
        if (missing) continue;

        const hourFloat = hh + mm / 60;
        const temp = tempAt(station, date, hourFloat, bias, rng);
        // Each plant has its own dispatch strategy: some shift load earlier in
        // the day, some shed it. The pilot requires the enrolled sites to pre-
        // cool or shift, so dispatch behaviour is site-specific and is NOT the
        // same as a temperature effect.
        const hvacKw = Math.max(0, temp - 60) * site.tempSensitivityKwPerF + Math.max(0, 55 - temp) * site.tempSensitivityKwPerF * 0.8;
        const precool = site.dispatch === 'precool' ? (slot >= 13 * 4 && slot < 16 * 4 ? 1.09 : 1) : 1;
        const preHeat = site.dispatch === 'preheat' ? (slot >= 12 * 4 && slot < 15 * 4 ? 1.11 : 1) : 1;
        let kw = site.baseKw * (1 - site.productionShare) + site.baseKw * site.productionShare * dayProfile + hvacKw * 0.5 * preHeat * precool + noise() * site.noiseSd * (preHeat > 1 || precool > 1 ? 1.35 : 1);

        for (const p of prodUtc) {
          if (p.siteId !== site.id) continue;
          if (tsUtc >= p.startUtc && tsUtc < p.endUtc) {
            const drop = p.expectedDropPct ?? 50;
            kw *= 1 - drop / 100;
          }
        }
        for (const w of eventWindows) {
          // In demo-v1 a logger outage means part of this dispatch has no
          // telemetry at all, so the realized curtailment is smaller than the
          // dispatched amount. v2 backfills the gap as *estimated* reads, which
          // the report excludes — the event does not become more successful
          // just because late data arrived.
          const cut = 0.85;
          if (tsUtc >= w.startUtc && tsUtc < w.endUtc) kw *= cut;
        }

        const estimated = ESTIMATED.some(
          (r) => r.localDate === date && (r.siteId === null || r.siteId === site.id) && slot / 4 >= r.fromHour && slot / 4 < r.toHour,
        );
        for (const [meterIdx, meter] of activeMeters.entries()) {
          // In an overlap both meters register the same interval with small
          // measurement differences; alignment must flag, not average, them.
          const factor = meterIdx === 0 ? 1 : 0.985;
          readRows.push([
            site.id,
            meter.id,
            iso(tsUtc),
            round((Math.max(0, kw) * factor) / 4, 3),
            estimated ? 'estimated' : 'measured',
            `${site.id}:${date}:${String(slot).padStart(2, '0')}:${meterIdx}`,
          ]);
        }
      }
    }
  }

  // Deliberate defects — quarantined by the ingest layer.
  const defects: Array<Array<string | number | null>> = [
    ['SITE-ARD', 'M-ARD-1', '2026-08-07T06:1:00Z', 3.2, 'measured', 'defect:bad-ts'],
    ['SITE-ARD', 'M-MTN-1', '2026-08-08T14:00:00Z', 4.0, 'measured', 'defect:wrong-meter'],
    ['SITE-GLN', 'M-GLN-1', '2026-08-03T10:30:00Z', -4.5, 'measured', 'defect:negative'],
    ['SITE-GLN', 'M-GLN-1', '2026-08-03T10:45:00Z', 9000, 'measured', 'defect:absurd'],
    ['SITE-MTN', 'M-MTN-1', '2026-06-01T00:00:00Z', 5.0, 'measured', 'defect:out-of-period'],
    ['SITE-ARD', 'M-ARD-1', '2026-08-13T18:00:00Z', 999, 'measured', 'defect:duplicate-conflict'],
  ];
  readRows.push(...defects);

  // ---------- events ----------
  const eventRows: Array<Array<string | number | null>> = [
    ['event_id', 'name', 'program', 'revision', 'status', 'site_ids', 'time_basis', 'local_date', 'local_start', 'local_end', 'start_utc', 'end_utc', 'issued_utc', 'changes', 'cancellation_utc', 'cancellation_reason', 'note'],
  ];
  for (const e of DEMO_EVENTS) {
    for (const r of e.revisions) {
      eventRows.push([
        e.id,
        e.name,
        e.program,
        r.revision,
        r.status,
        r.siteIds.join(';'),
        r.timeBasis,
        r.localDate,
        r.localStart,
        r.localEnd,
        r.startUtc,
        r.endUtc,
        r.issuedAtUtc,
        r.changes,
        r.cancellationAtUtc,
        r.cancellationReason,
        r.note,
      ]);
    }
  }

  // ---------- holidays ----------
  const holidayRows: Array<Array<string | number>> = [
    ['date', 'name', 'site_ids', 'note'],
    ['2026-08-17', 'Founders Day', 'SITE-RIV', 'Plant holiday; production closed.'],
    ['2026-08-21', 'County Fair Day', 'SITE-ARD', 'Local holiday; office closed, refrigeration still running.'],
    ['2026-09-07', 'Labor Day', '', 'US federal holiday; all sites.'],
    ['2026-10-12', 'Columbus Day', '', 'US federal holiday; all sites.'],
  ];

  // ---------- v2 corrections (late-arriving backfill + production correction) ----------
  const correctionRows: Array<Array<string | number | null>> = [
    ['kind', 'site_id', 'start_utc', 'read_ts_utc', 'kwh', 'quality', 'field', 'new_value', 'note'],
    ['read', 'SITE-RIV', '', iso(localWallToUtc('2026-08-27', '17:00', 'America/Chicago')), 96.1, 'estimated', '', '', 'Late logger backfill, flagged estimated.'],
    ['read', 'SITE-RIV', '', iso(localWallToUtc('2026-08-27', '17:15', 'America/Chicago')), 98.7, 'estimated', '', '', 'Late logger backfill, flagged estimated.'],
    ['read', 'SITE-RIV', '', iso(localWallToUtc('2026-08-27', '17:30', 'America/Chicago')), 101.3, 'estimated', '', '', 'Late logger backfill, flagged estimated.'],
    ['production', 'SITE-RIV', iso(localWallToUtc('2026-08-20', '10:00', 'America/Chicago')), '', '', '', 'verified', 'true', 'Aug 20 shift note countersigned; now a verified anomaly.'],
    ['production', 'SITE-RIV', iso(localWallToUtc('2026-08-20', '10:00', 'America/Chicago')), '', '', '', 'expected_drop_pct', '18', 'Countersigned estimate of 18% load loss for the line jam.'],
  ];

  const files = [
    { name: 'sites.csv', kind: 'sites', content: csv(siteRows) },
    { name: 'stations.csv', kind: 'stations', content: csv(stationRows) },
    { name: 'interval_reads.csv', kind: 'reads', content: csv(readRows) },
    { name: 'weather_hourly.csv', kind: 'weather', content: csv(weatherRows) },
    { name: 'production_log.csv', kind: 'production', content: csv(prodRows) },
    { name: 'meter_registry.csv', kind: 'meters', content: csv(meterRows) },
    { name: 'dr_events.csv', kind: 'events', content: csv(eventRows) },
    { name: 'holidays.csv', kind: 'holidays', content: csv(holidayRows) },
    { name: 'corrections_v2.csv', kind: 'corrections', content: csv(correctionRows) },
  ].map((f) => {
    const content = f.content.endsWith('\n') ? f.content : f.content + '\n';
    return {
      name: f.name,
      kind: f.kind,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      rows: Math.max(0, content.trim().split('\n').length - 1),
    };
  });

  return { files };
}

export function writeSyntheticDataset(opts: GeneratorOptions & { outDir: string; manifestExtra?: Record<string, unknown> }): GeneratedDataset {
  const ds = generateSyntheticDataset(opts);
  mkdirSync(opts.outDir, { recursive: true });
  for (const f of ds.files) writeFileSync(join(opts.outDir, f.name), f.content);
  writeFileSync(
    join(opts.outDir, 'manifest.json'),
    JSON.stringify(
      {
        synthetic: true,
        seed: opts.seed,
        analysisStartDate: opts.startDate,
        analysisEndDate: opts.endDate,
        note: 'Synthetic data for engineering demonstration only. Not real utility, customer, or settlement data.',
        files: ds.files.map((f) => ({ name: f.name, kind: f.kind, rows: f.rows, sha256: f.sha256 })),
        ...opts.manifestExtra,
      },
      null,
      2,
    ) + '\n',
  );
  return ds;
}

export { SITES, STATIONS, addDays };
