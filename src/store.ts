/**
 * Durable store: dataset versions, reports, and analysis tasks.
 *
 * Everything is a JSON file under data/store. No database, no external
 * service. Writes are atomic (write temp, rename) so a crash cannot leave a
 * half-written report that the UI would then try to render.
 *
 * Tasks are *resumable*: a task is persisted before it starts, its progress is
 * checkpointed as it runs, and on process start any task still marked running
 * is flipped to `interrupted` with a restore note. `POST /api/tasks/:id/restore`
 * creates a new task from the original config — it never mutates history.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, mergeExclusions } from './report.js';
import { summarizeReport, type ReportSummary } from './compare.js';
import type {
  AnalysisTask,
  DatasetVersion,
  ExclusionConfig,
  Report,
  Site,
  TaskConfig,
  TaskLogEntry,
  TaskStatus,
  VersionDiff,
} from './types.js';
import { hashOf } from './util.js';

export interface VersionIndex {
  latest: string;
  order: string[];
  diff: VersionDiff | null;
  builtAt: string;
}

export interface StoreOptions {
  root: string;
}

const REPORT_DIR = 'reports';
const TASK_DIR = 'tasks';

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class Store {
  readonly root: string;
  private versions: Map<string, DatasetVersion> = new Map();
  private index: VersionIndex;
  private reports: Map<string, Report> = new Map();
  private tasks: Map<string, AnalysisTask> = new Map();
  private queue: string[] = [];
  private pumping = false;

  constructor(opts: StoreOptions) {
    this.root = opts.root;
    mkdirSync(join(this.root, REPORT_DIR), { recursive: true });
    mkdirSync(join(this.root, TASK_DIR), { recursive: true });
    this.index = this.readIndex();
    this.loadVersions();
    this.loadReports();
    this.loadTasks();
    this.recoverInterrupted();
  }

  // ---------- versions ----------

  private readIndex(): VersionIndex {
    const p = join(this.root, 'versions.json');
    if (!existsSync(p)) return { latest: '', order: [], diff: null, builtAt: new Date(0).toISOString() };
    return JSON.parse(readFileSync(p, 'utf8')) as VersionIndex;
  }

  private loadVersions(): void {
    for (const id of this.index.order) {
      const candidates = [`dataset-${id}.json`, `dataset-v${this.index.order.indexOf(id) + 1}.json`];
      const found = candidates.map((f) => join(this.root, f)).find((p) => existsSync(p));
      if (found) this.versions.set(id, JSON.parse(readFileSync(found, 'utf8')) as DatasetVersion);
    }
    // Fallback: pick up any dataset-*.json whose id is not in the index.
    for (const f of readdirSync(this.root)) {
      if (!f.startsWith('dataset-') || !f.endsWith('.json')) continue;
      const ds = JSON.parse(readFileSync(join(this.root, f), 'utf8')) as DatasetVersion;
      if (!this.versions.has(ds.id)) {
        this.versions.set(ds.id, ds);
        if (!this.index.order.includes(ds.id)) this.index.order.push(ds.id);
      }
    }
    if (this.index.order.length && !this.index.latest) this.index.latest = this.index.order[this.index.order.length - 1];
  }

  versionList(): { id: string; label: string; createdAtUtc: string; sourceLabel: string; asOf: string }[] {
    return this.index.order
      .map((id) => this.versions.get(id))
      .filter((v): v is DatasetVersion => !!v)
      .map((v) => ({
        id: v.id,
        label: v.label,
        createdAtUtc: v.createdAtUtc,
        sourceLabel: v.sourceLabel,
        asOf: v.createdAtUtc,
      }));
  }

  latestVersionId(): string {
    return this.index.latest || this.index.order[this.index.order.length - 1] || '';
  }

  /** False when the store has no pinned dataset yet (e.g. gen:demo never run). */
  hasVersions(): boolean {
    return this.versions.size > 0;
  }

  getVersion(id: string | null): DatasetVersion {
    const want = id ?? this.latestVersionId();
    const v = this.versions.get(want);
    if (!v) throw new Error(`Unknown dataset version ${want}`);
    return v;
  }

  versionDiff(): VersionDiff | null {
    return this.index.diff;
  }

  // ---------- reports ----------

  private loadReports(): void {
    const dir = join(this.root, REPORT_DIR);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Report;
        this.reports.set(r.id, r);
      } catch {
        /* a corrupt report file must not stop the service from starting */
      }
    }
  }

  private loadTasks(): void {
    const dir = join(this.root, TASK_DIR);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as AnalysisTask;
        this.tasks.set(t.id, t);
      } catch {
        /* ignore corrupt task */
      }
    }
  }

  private recoverInterrupted(): void {
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'interrupted';
        t.interruptedAt = t.finishedAt ?? Date.now();
        t.finishedAt = Date.now();
        t.error = 'The server stopped before the task completed. Use Restore to rerun it with the same inputs.';
        t.log.push({ at: Date.now(), step: 'recover', message: t.error, level: 'warning' });
        this.persistTask(t);
        changed = true;
      }
    }
    if (changed) this.log('recovered interrupted tasks');
  }

  private log(msg: string): void {
    if (process.env.DR_QUIET) return;
    console.log(`[store] ${msg}`);
  }

  persistTask(t: AnalysisTask): void {
    atomicWrite(join(this.root, TASK_DIR, `${t.id}.json`), JSON.stringify(t));
  }

  addReport(r: Report): void {
    this.reports.set(r.id, r);
    atomicWrite(join(this.root, REPORT_DIR, `${r.id}.json`), JSON.stringify(r));
  }

  getReport(id: string): Report | undefined {
    return this.reports.get(id);
  }

  reportSummaries(): ReportSummary[] {
    return [...this.reports.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summarizeReport);
  }

  getTask(id: string): AnalysisTask | undefined {
    return this.tasks.get(id);
  }

  taskList(): AnalysisTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------- task execution ----------

  createTask(input: {
    config: TaskConfig;
    id?: string;
    restoredFromTaskId?: string | null;
    restoreNote?: string | null;
    parentReportId?: string | null;
  }): AnalysisTask {
    const now = Date.now();
    const id = input.id ?? `task-${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    const task: AnalysisTask = {
      id,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      progress: 0,
      step: 'queued',
      config: input.config,
      pinnedDatasetVersionId: input.config.datasetVersionId,
      reportIds: [],
      error: null,
      log: [],
      restoredFromTaskId: input.restoredFromTaskId ?? null,
      restoreNote: input.restoreNote ?? null,
      parentReportId: input.parentReportId ?? null,
    } as AnalysisTask;
    this.tasks.set(id, task);
    this.persistTask(task);
    return task;
  }

  restoreTask(sourceTaskId: string, overrides?: Partial<TaskConfig>): AnalysisTask | null {
    const src = this.tasks.get(sourceTaskId);
    if (!src) return null;
    const config: TaskConfig = {
      ...src.config,
      ...overrides,
      exclusions: { ...src.config.exclusions, ...(overrides?.exclusions ?? {}) },
    };
    return this.createTask({
      config,
      restoredFromTaskId: src.id,
      restoreNote: `Restored from ${src.id} (${src.status}). Original inputs kept: dataset ${src.pinnedDatasetVersionId}, exclusions ${src.config.exclusions ? hashOf(src.config.exclusions) : '—'}.`,
      parentReportId: src.reportIds[src.reportIds.length - 1] ?? null,
    });
  }

  cancelTask(id: string): AnalysisTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.status === 'queued' || t.status === 'running') {
      t.status = 'cancelled' as TaskStatus;
      t.finishedAt = Date.now();
      t.error = 'Cancelled by request.';
      t.log.push({ at: Date.now(), step: 'cancel', message: t.error, level: 'warning' });
      this.persistTask(t);
    }
    return t;
  }

  /** Queue a task and return immediately; the HTTP client polls for progress. */
  enqueue(id: string): void {
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    const next = this.queue.shift();
    if (!next) return;
    this.pumping = true;
    setImmediate(() => {
      try {
        this.runTask(next);
      } finally {
        this.pumping = false;
        if (this.queue.length) setTimeout(() => this.pump(), 10);
      }
    });
  }

  /**
   * Run a task synchronously (the dataset is in memory and a report takes
   * ~150 ms). Progress is written at each step so a crashed run leaves a
   * usable trail, and the report is persisted before the task is marked
   * succeeded.
   */
  runTask(id: string): AnalysisTask | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (t.status !== 'queued') return t;
    const started = Date.now();
    t.status = 'running';
    t.startedAt = started;
    t.step = 'load dataset';
    t.progress = 0.05;
    this.addLog(t, 'load dataset', `Using dataset version ${t.config.datasetVersionId}.`);
    this.persistTask(t);

    try {
      const dataset = this.getVersion(t.config.datasetVersionId);
      const site = dataset.sites.find((s) => s.id === t.config.siteId);
      if (!site) throw new Error(`Site ${t.config.siteId} is not present in dataset ${dataset.id}.`);

      this.step(t, 0.2, 'align intervals');
      t.progress = 0.35;
      this.step(t, 0.45, 'classify exclusions');

      const exclusions: ExclusionConfig = mergeExclusions(t.config.exclusions);
      const reportId = `rep-${t.id}-${Date.now().toString(36)}`;
      this.step(t, 0.6, 'build baselines');

      const report = buildReport({
        dataset,
        site,
        eventId: t.config.eventId,
        revisionId: t.config.eventRevisionId,
        exclusions,
        taskId: t.id,
        taskLabel: t.config.label,
        scope: t.config.scope,
        validationDate: t.config.validationDate,
        reportId,
        now: Date.now(),
        parentReportId: t.parentReportId ?? null,
        latestDatasetVersionId: this.latestVersionId(),
      });

      this.step(t, 0.85, 'bootstrap uncertainty');
      this.addReport(report);
      t.reportIds.push(report.id);
      t.status = 'succeeded';
      t.progress = 1;
      t.step = 'done';
      t.finishedAt = Date.now();
      this.addLog(
        t,
        'done',
        `Report ${report.id}: ${report.statusLabel}, savings ${report.results.savingsKwh ?? '—'} kWh (${report.methodLabel}).`,
      );
      this.persistTask(t);
      return t;
    } catch (err) {
      t.status = 'failed';
      t.progress = 1;
      t.step = 'failed';
      t.finishedAt = Date.now();
      t.error = err instanceof Error ? err.message : String(err);
      this.addLog(t, 'failed', t.error, 'error');
      this.persistTask(t);
      return t;
    }
  }

  private step(t: AnalysisTask, progress: number, name: string): void {
    t.progress = progress;
    t.step = name;
    this.addLog(t, name, `step: ${name}`);
    this.persistTask(t);
  }

  private addLog(t: AnalysisTask, step: string, message: string, level: TaskLogEntry['level'] = 'info'): void {
    t.log.push({ at: Date.now(), step, message, level });
    if (t.log.length > 40) t.log.splice(0, t.log.length - 40);
  }

  // ---------- derived views ----------

  sites(): Site[] {
    const ds = this.versions.get(this.latestVersionId()) ?? [...this.versions.values()][0];
    return ds ? ds.sites : [];
  }

  dataQuality(): {
    versions: { id: string; label: string; createdAtUtc: string; counts: Record<string, number>; quarantineByCode: Record<string, number>; quarantine: unknown[] }[];
    diff: VersionDiff | null;
  } {
    return {
      versions: this.index.order
        .map((id) => this.versions.get(id))
        .filter((v): v is DatasetVersion => !!v)
        .map((v) => ({
          id: v.id,
          label: v.label,
          createdAtUtc: v.createdAtUtc,
          counts: {
            sites: v.sites.length,
            meters: v.meters.length,
            reads: v.reads.length,
            weather: v.weather.length,
            production: v.production.length,
            events: v.events.length,
            quarantined: v.quarantine.length,
          },
          quarantineByCode: v.ingest.byCode,
          quarantine: v.quarantine.slice(0, 60),
        })),
      diff: this.index.diff,
    };
  }
}
