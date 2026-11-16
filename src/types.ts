/** Domain model for the synthetic demand-response attribution lab. */

export type ProductionStatus =
  | 'normal'
  | 'planned_maintenance'
  | 'unplanned_shutdown'
  | 'reduced'
  | 'non_routine';

export type ReadQuality = 'measured' | 'estimated';

export interface Site {
  id: string;
  name: string;
  timezone: string;
  segment: string;
  floorAreaSqft: number;
  weatherStationId: string;
  latitude: number;
  longitude: number;
  note: string;
}

export interface Meter {
  id: string;
  siteId: string;
  serial: string;
  installedAtUtc: number;
  removedAtUtc: number | null;
  multiplier: number;
  note: string;
}

export interface RawRead {
  siteId: string;
  meterId: string;
  tsUtc: number;
  kwh: number;
  quality: ReadQuality;
  rowRef: string;
}

export interface WeatherObs {
  stationId: string;
  tsUtc: number;
  tempF: number;
  humidityPct: number | null;
  rowRef: string;
}

export interface Station {
  id: string;
  name: string;
  city: string;
  note: string;
}

export interface ProductionRecord {
  id: string;
  siteId: string;
  startUtc: number;
  endUtc: number;
  status: ProductionStatus;
  verified: boolean;
  expectedDropPct: number | null;
  source: string;
  note: string;
}

export interface Holiday {
  date: string; // local YYYY-MM-DD
  name: string;
  siteIds: string[]; // empty means all sites
}

export type EventStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';
export type EventTimeBasis = 'utc' | 'site_local';

export interface EventRevision {
  id: string;
  eventId: string;
  revision: number;
  status: EventStatus;
  siteIds: string[];
  localDate: string | null;
  localStart: string | null;
  localEnd: string | null;
  timeBasis: EventTimeBasis;
  startUtc: number | null;
  endUtc: number | null;
  siteWindows: { siteId: string; startUtc: number; endUtc: number }[];
  issuedAtUtc: number;
  note: string;
  changes: string[];
  supersedesRevisionId: string | null;
  cancellationAtUtc: number | null;
  cancellationReason: string | null;
  cancelledByRevisionId: string | null;
}

export interface DrEvent {
  id: string;
  name: string;
  program: string;
  currentRevisionId: string;
  currentScheduledRevisionId: string | null;
  revisions: EventRevision[];
}

export interface QuarantineRow {
  rowRef: string;
  code: string;
  detail: string;
  raw: string;
}

export interface IngestFileInfo {
  name: string;
  kind: string;
  bytes: number;
  rows: number;
  sha256: string;
}

export interface IngestSummary {
  files: IngestFileInfo[];
  rawRows: number;
  acceptedReads: number;
  acceptedWeather: number;
  quarantined: number;
  byCode: Record<string, number>;
  duplicatesDropped: number;
  outOfPeriodReads: number;
  outOfPeriodWeather: number;
  warnings: string[];
  asOfLabel: string;
}

export interface DatasetVersion {
  id: string;
  label: string;
  createdAtUtc: string;
  sourceLabel: string;
  notes: string[];
  analysisStartDate: string;
  analysisEndDate: string;
  sites: Site[];
  stations: Station[];
  meters: Meter[];
  reads: RawRead[];
  weather: WeatherObs[];
  production: ProductionRecord[];
  holidays: Holiday[];
  events: DrEvent[];
  quarantine: QuarantineRow[];
  ingest: IngestSummary;
  rawHash: string;
}

export type IntervalStatus =
  | 'ok'
  | 'missing'
  | 'meter_conflict'
  | 'no_active_meter'
  | 'estimated_excluded'
  | 'invalid';

export interface AlignedInterval {
  tsUtc: number;
  localDate: string;
  localTime: string;
  offsetMinutes: number;
  kwh: number | null;
  status: IntervalStatus;
  quality: ReadQuality | null;
  meterId: string | null;
  tempF: number | null;
  tempSource: 'observed' | 'nearest' | null;
  productionStatus: ProductionStatus;
  productionRecords: ProductionRecordRef[];
  productionNotes: string[];
  warnings: string[];
  eventIds: string[];
}

export interface ProductionRecordRef {
  id: string;
  status: ProductionStatus;
  verified: boolean;
  note: string;
}

export interface AlignedDay {
  date: string;
  startUtc: number;
  endUtc: number;
  expectedIntervals: number;
  dstTransition: boolean;
  dstNote: string | null;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  eventIds: string[];
  meterExchange: boolean;
  meterExchangeNote: string | null;
  productionAnomalyStatuses: ProductionStatus[];
  productionVerifiedExclusion: boolean;
  coverage: number;
  presentIntervals: number;
  meanLoadKw: number | null;
  meanTempF: number | null;
  productionAdjustmentKwh: number;
  intervals: AlignedInterval[];
}

export interface AlignmentWarning {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  examples: string[];
}

export interface IntervalIssue {
  tsUtc: number;
  code: string;
  detail: string;
}

export interface SiteAlignment {
  site: Site;
  days: Map<string, AlignedDay>;
  dayList: AlignedDay[];
  warnings: AlignmentWarning[];
  summary: {
    days: number;
    intervals: number;
    present: number;
    missing: number;
    conflict: number;
    estimatedExcluded: number;
    noActiveMeter: number;
    invalid: number;
    duplicatesDropped: number;
    missingExamples: IntervalIssue[];
    conflicts: IntervalIssue[];
    meterDuringReads: IntervalIssue[];
    duplicateReadList: IntervalIssue[];
    outsideMeterExamples: IntervalIssue[];
  };
}

export type MethodId = 'matched_10of10_weather' | 'matched_4of5_weather' | 'weather_regression';

export interface ExclusionConfig {
  minDayCoverage: number;
  minActualCoverage: number;
  minAttributableShare: number;
  dailyCommit: boolean;
  excludeProductionStatuses: ProductionStatus[];
  excludeUnverifiedProduction: boolean;
  excludeHolidays: boolean;
  excludeEventDays: boolean;
  excludeDstTransitionDays: boolean;
  excludeMeterExchangeDays: boolean;
  treatEstimatedAsMissing: boolean;
  maxWeatherSlopeKwhPerF: number;
  requireTemperatureOverlap: boolean;
  temperatureOverlapMarginF: number;
  lookbackDays: number;
  matchedDayCount: number;
  recentPoolSize: number;
  minMatchedDays: number;
  matchTempToleranceF: number;
  minMatchTempToleranceF: number;
  regressionMinDays: number;
  minSlotSampleRatio: number;
  weatherCorrection: boolean;
  bootstrapReplicates: number;
  bootstrapUnit: 'day';
  confidenceLevel: number;
  autoPolicy: 'min_uncertainty' | 'prefer_matched' | 'prefer_weather';
  methodOverride: MethodId | null;
}

export interface Check {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface DayExclusion {
  date: string;
  reasons: string[];
  selectedMatched: boolean;
}

export interface TrainingSample {
  candidateDays: number;
  matchedDays: number;
  examinedDays: number;
  excludedDays: number;
  excludedByReason: Record<string, number>;
  excludedUnverifiedAnomalyDays: number;
  matchedDates: string[];
  excludedExamples: DayExclusion[];
  candidateExamples: DayExclusion[];
  windowStartDate: string;
  windowEndDate: string;
  trainingEndUtc: number;
  eventStartUtc: number;
  leakageGuard: string;
  perSlotMinSamples: number;
  perSlotMinTempSamples: number;
  medianR2: number | null;
  tempRangeF: [number, number] | null;
  eventTempRangeF: [number, number] | null;
  matchTempToleranceF: number;
  /** Widest temperature deviation actually accepted by the rule (0 when N/A). */
  matchToleranceUsedF: number;
  observedMatchDeviationF: number | null;
  /** True when training was limited to the event's weekday/weekend day type. */
  dayTypeRestricted: boolean;
  dayType: 'weekday' | 'weekend';
  /** Days with both load and temperature that went into the weather-slope fit. */
  slopeSampleDays: number;
  slopeKwhPerF: number | null;
  slopeNote: string;
  slopeIsValid: boolean;
  slopeAdjustmentKwh: number | null;
  weatherExtrapolation: boolean;
  selectedSummary: string;
}

export interface MethodSeriesPoint {
  tsUtc: number;
  baselineKwh: number | null;
  ci90: [number, number] | null;
}

export interface MethodDelta {
  baselineKwh: number;
  savingsKwh: number | null;
  savingsDiffKwh: number | null;
  savingsPctOfBaseline: number | null;
  coveragePts: number | null;
  note: string;
}

export interface MethodCoverage {
  windowIntervals: number;
  paired: number;
  attributable: number;
  pairedFraction: number;
}

export interface MethodResult {
  method: MethodId;
  label: string;
  description: string;
  applicable: boolean;
  checks: Check[];
  sample: TrainingSample;
  baselineKwh: number | null;
  baselineCoverage: number;
  baselineGapReasons: Record<string, number>;
  actualKwh: number | null;
  coverage: MethodCoverage;
  coverageNote: string;
  windowDropKwh: number | null;
  nonDrDropKwh: number | null;
  savingsKwh: number | null;
  savingsCi90: [number, number] | null;
  uncertaintyPct: number | null;
  savingsPct: number | null;
  srm: number | null;
  warningCodes: string[];
  selected: boolean;
  selectionReason: string;
  deltaVsSelected: MethodDelta | null;
  series: MethodSeriesPoint[];
}

export type ReportStatus =
  | 'ok'
  | 'no_rule'
  | 'insufficient_attribution'
  | 'no_window'
  | 'training_only';

export interface ReportWarning {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  detail?: string;
}

export interface ExclusionDetail {
  code: string;
  label: string;
  count: number;
  kWh: number | null;
  indexRanges: string;
  perIntervalKwh: number | null;
}

export interface AttributionExclusions {
  expected: number;
  actualCoverage: number;
  baselineCoverage: number;
  attributable: number;
  missing: number;
  conflict: number;
  productionAffected: number;
  meterExchangeAffected: number;
  reasons: ExclusionDetail[];
  missingIntervals: number;
}

export interface ReportInterval {
  index: number;
  tsUtc: number;
  localDate: string;
  localTime: string;
  offsetMinutes: number;
  tempF: number | null;
  baselineKwh: number | null;
  baselineCi90: [number, number] | null;
  actualKwh: number | null;
  actualQuality: ReadQuality | null;
  baselineStatus: 'ok' | 'missing' | 'outside_coverage';
  actualStatus: 'ok' | 'missing' | 'excluded';
  attributable: boolean;
  exclusionCodes: string[];
  productionStatus: ProductionStatus;
  productionVerifiedAnomaly: boolean;
  productionUnverifiedAnomaly: boolean;
  meterId: string | null;
  observedDeltaKwh: number | null;
  isDerivedWeather: boolean;
}

export interface ReportWindow {
  startUtc: number;
  endUtc: number;
  localStart: string;
  localEnd: string;
  offsetStart: string;
  offsetEnd: string;
  expectedIntervals: number;
  dstTransition: boolean;
  localDates: string[];
  scheduledStartUtc: number | null;
  scheduledEndUtc: number | null;
  cancelledAtUtc: number | null;
  cancellationReason: string | null;
  truncatedByCancellation: boolean;
  timeBasis: EventTimeBasis;
}

export interface ReportResults {
  baselineKwh: number | null;
  baselineCi90: [number, number] | null;
  actualKwh: number | null;
  savingsKwh: number | null;
  savingsCi90: [number, number] | null;
  savingsPct: number | null;
  observedDropKwh: number | null;
  observedDropPct: number | null;
  nonDrDropKwh: number | null;
  savingsIsPartial: boolean;
  attributableCoverage: number;
  actualCoverage: number;
  baselineCoverage: number;
  estimatedKwhInActual: number;
  estimatedKwhInBaseline: number;
  attributionNote: string;
}

export interface ConfidenceSummary {
  level: number;
  unit: 'kWh';
  bootstrapUnit: 'day';
  replicates: number;
  seed: number;
  method: string;
  note: string;
  suggestions: string[];
}

export interface ReportBasis {
  datasetVersionId: string;
  datasetLabel: string;
  siteId: string;
  eventId: string;
  eventRevisionId: string;
  method: MethodId;
  exclusionsHash: string;
  businessHash: string;
  windowHash: string;
  suiteHash: string;
}

export interface Report {
  id: string;
  createdAt: number;
  taskId: string;
  taskLabel: string;
  scope: 'event' | 'training_validation';
  validationDate: string | null;
  status: ReportStatus;
  statusLabel: string;
  claimable: boolean;
  datasetVersionId: string;
  datasetLabel: string;
  latestDatasetVersionId: string;
  siteId: string;
  siteName: string;
  siteTimezone: string;
  eventId: string;
  eventName: string;
  eventRevisionId: string;
  revisionNumber: number;
  revisionStatus: EventStatus;
  method: MethodId | null;
  methodLabel: string;
  methodPolicy: ExclusionConfig['autoPolicy'] | 'manual' | 'validation';
  basis: ReportBasis;
  exclusions: ExclusionConfig;
  window: ReportWindow;
  boardTime: string;
  intervals: ReportInterval[];
  methods: MethodResult[];
  results: ReportResults;
  attribution: AttributionExclusions;
  uncertainty: ConfidenceSummary;
  warnings: ReportWarning[];
  notes: string[];
  parentReportId: string | null;
  restoredFromTaskId?: string;
}

export interface TaskConfig {
  label: string;
  scope: 'event' | 'training_validation';
  datasetVersionId: string;
  siteId: string;
  eventId: string;
  eventRevisionId: string | null;
  validationDate: string | null;
  exclusions: ExclusionConfig;
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';

export interface TaskLogEntry {
  at: number;
  step: string;
  message: string;
  level: 'info' | 'warning' | 'error';
}

export interface AnalysisTask {
  id: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: TaskStatus;
  progress: number;
  step: string;
  config: TaskConfig;
  pinnedDatasetVersionId: string;
  reportIds: string[];
  error: string | null;
  log: TaskLogEntry[];
  restoredFromTaskId: string | null;
  restoreNote: string | null;
  /** Report the restored task was seeded from, if any. */
  parentReportId?: string | null;
  /** Timestamp at which the process was found to have died mid-task. */
  interruptedAt?: number | null;
}

export interface VersionDiff {
  fromVersionId: string;
  addedReads: number;
  correctedReads: number;
  productionChanges: { siteId: string; startUtc: number; field: string; oldValue: string; newValue: string }[];
  notes: string[];
}

export interface CompareMismatch {
  field: string;
  label: string;
  a: string;
  b: string;
  severity: 'critical' | 'warning' | 'info';
  blocksExact: boolean;
  message: string;
}

export interface CompareSide {
  id: string;
  label: string;
  datasetVersionId: string;
  eventRevisionId: string;
  revisionNumber: number;
  method: MethodId | null;
  exclusionsHash: string;
  businessHash: string;
  windowHash: string;
  window: ReportWindow;
  baselineKwh: number | null;
  savingsKwh: number | null;
  savingsCi90: [number, number] | null;
  attributableCoverage: number;
  intervals: ReportInterval[];
}

export interface CompareResult {
  comparable: boolean;
  comparability: 'exact' | 'revision' | 'method' | 'incomparable';
  mismatches: CompareMismatch[];
  a: CompareSide;
  b: CompareSide;
  deltas: {
    baselineKwh: number | null;
    savingsKwh: number | null;
    savingsPctOfBaseline: number | null;
    attributableCoveragePts: number | null;
    intervalCount: number | null;
  } | null;
  commonWindow: {
    startUtc: number;
    endUtc: number;
    minutes: number;
    intervals: number;
    a: { baselineKwh: number; actualKwh: number; savingsKwh: number | null; attributable: number };
    b: { baselineKwh: number; actualKwh: number; savingsKwh: number | null; attributable: number };
    deltaSavingsKwh: number | null;
  } | null;
  notes: string[];
}
