/**
 * HTTP API + static file server. No external dependencies.
 *
 * Routes (all JSON unless noted):
 *   GET  /api/state                  bootstrap: sites, events, versions, defaults, tasks, reports
 *   GET  /api/events                 event catalogue with revisions
 *   GET  /api/data-quality           ingest counts, quarantine rows, version diff
 *   GET  /api/tasks                  task history
 *   POST /api/tasks                  create + enqueue an analysis task
 *   GET  /api/tasks/:id              task progress and log
 *   POST /api/tasks/:id/restore      new task from an old task's pinned inputs
 *   POST /api/tasks/:id/cancel       stop a queued/running task
 *   GET  /api/reports                report summaries
 *   GET  /api/reports/:id            full report
 *   GET  /api/reports/:id.csv        interval series CSV (text/csv)
 *   POST /api/compare                { a, b } report ids -> CompareResult
 *   GET  /api/health                 liveness
 *
 * Static assets live in web/ and are served for any non-/api path, with
 * index.html as the fallback so the client-side router can handle deep links.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports, reportCsv } from './compare.js';
import { DEFAULT_EXCLUSIONS, METHOD_LABELS } from './baseline.js';
import { mergeExclusions } from './report.js';
import { Store } from './store.js';
import type { ExclusionConfig, MethodId, TaskConfig } from './types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
/** Walk up from the module to the directory that holds package.json, so the
 *  same code works from src/ (tsx) and from dist/src/ (compiled). */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, '..');
}
export const projectRoot = findProjectRoot(here);
const webRoot = join(projectRoot, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Expected a JSON object');
  return v as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `${field} must be a non-empty string`);
  return v.trim();
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

const METHOD_IDS: MethodId[] = ['matched_10of10_weather', 'matched_4of5_weather', 'weather_regression'];

export interface ServerOptions {
  storeRoot?: string;
  port?: number;
  host?: string;
}

export function createApp(opts: ServerOptions = {}) {
  const store = new Store({ root: opts.storeRoot ?? process.env.DR_STORE ?? join(projectRoot, 'data', 'store') });
  const basePath = (process.env.DR_BASE_PATH ?? '').replace(/\/+$/, '');

  const eventCatalogue = () => {
    const ds = store.getVersion(null);
    return ds.events.map((e) => {
      const latest = e.revisions[e.revisions.length - 1];
      return {
        id: e.id,
        name: e.name,
        program: e.program,
        revisionCount: e.revisions.length,
        latestRevisionId: latest.id,
        latestRevision: latest.revision,
        status: latest.status,
        siteIds: [...new Set(e.revisions.flatMap((r) => r.siteIds))],
        note: latest.note,
        revisions: e.revisions.map((r) => ({
          id: r.id,
          revision: r.revision,
          status: r.status,
          siteIds: r.siteIds,
          timeBasis: r.timeBasis,
          startUtc: r.startUtc,
          endUtc: r.endUtc,
          localStart: r.localStart,
          localEnd: r.localEnd,
          issuedAtUtc: r.issuedAtUtc,
          changes: r.changes,
          cancellationAtUtc: r.cancellationAtUtc,
          cancellationReason: r.cancellationReason,
          supersedesRevisionId: r.supersedesRevisionId,
          note: r.note,
        })),
      };
    });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let path = url.pathname;
    // Behind a reverse proxy the app may be mounted under a prefix; the client
    // sends its API calls to the same prefix it was loaded from.
    if (basePath && path.startsWith(basePath + '/')) path = path.slice(basePath.length);

    if (!path.startsWith('/api/')) {
      return serveStatic(path, res);
    }

    try {
      const method = req.method ?? 'GET';

      if (path === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          ok: store.hasVersions(),
          latestDatasetVersionId: store.latestVersionId(),
          hint: store.hasVersions() ? null : 'No dataset version pinned. Run `npm run gen:demo` and restart.',
        });
      }

      if (path === '/api/state' && method === 'GET') {
        requireDataset(store);
        const ds = store.getVersion(null);
        return sendJson(res, 200, {
          latestDatasetVersionId: ds.id,
          versions: store.versionList(),
          sites: ds.sites.map((s) => ({
            id: s.id,
            name: s.name,
            timezone: s.timezone,
            segment: s.segment,
            floorAreaSqft: s.floorAreaSqft,
            weatherStationId: s.weatherStationId,
            note: s.note,
          })),
          events: eventCatalogue(),
          defaults: DEFAULT_EXCLUSIONS,
          methodLabels: METHOD_LABELS,
          methodIds: METHOD_IDS,
          tasks: store.taskList().slice(0, 25),
          reports: store.reportSummaries().slice(0, 50),
          versionDiff: store.versionDiff(),
          dataQuality: store.dataQuality(),
          disclaimer: 'Synthetic demonstration data. Not a settlement, dispatch, or grid-control system.',
        });
      }

      if (path === '/api/events' && method === 'GET') {
        requireDataset(store);
        return sendJson(res, 200, { events: eventCatalogue() });
      }

      if (path === '/api/data-quality' && method === 'GET') {
        return sendJson(res, 200, store.dataQuality());
      }

      if (path === '/api/tasks' && method === 'GET') {
        return sendJson(res, 200, { tasks: store.taskList() });
      }

      if (path === '/api/tasks' && method === 'POST') {
        const body = asRecord(await readBody(req));
        const config = parseTaskConfig(body, store);
        const task = store.createTask({ config });
        store.enqueue(task.id);
        // Give the queue a moment so a fast run can report real progress on the
        // first poll rather than a stale `queued` snapshot.
        await new Promise((r) => setTimeout(r, 5));
        return sendJson(res, 202, { task: store.getTask(task.id) });
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(restore|cancel))?$/.exec(path);
      if (taskMatch) {
        const [, id, action] = taskMatch;
        const task = store.getTask(id);
        if (!task) throw new HttpError(404, `Unknown task ${id}`);

        if (!action && method === 'GET') {
          const reports = task.reportIds.map((rid) => store.getReport(rid)).filter(Boolean);
          return sendJson(res, 200, { task, reports: reports.map((r) => ({ id: r!.id, status: r!.status, savingsKwh: r!.results.savingsKwh })) });
        }

        if (action === 'restore' && method === 'POST') {
          const body = method === 'POST' ? asRecord(await readBody(req)) : {};
          const overrides: Partial<TaskConfig> = {};
          if (typeof body.datasetVersionId === 'string') overrides.datasetVersionId = body.datasetVersionId;
          if (typeof body.eventRevisionId === 'string') overrides.eventRevisionId = body.eventRevisionId;
          if (body.exclusions && typeof body.exclusions === 'object') {
            overrides.exclusions = mergeExclusions({ ...task.config.exclusions, ...(body.exclusions as object) });
          }
          const restored = store.restoreTask(id, overrides);
          if (!restored) throw new HttpError(404, `Unknown task ${id}`);
          store.enqueue(restored.id);
          return sendJson(res, 201, { task: store.getTask(restored.id) });
        }

        if (action === 'cancel' && method === 'POST') {
          const cancelled = store.cancelTask(id);
          return sendJson(res, 200, { task: cancelled });
        }

        throw new HttpError(405, `Method ${method} not allowed on ${path}`);
      }

      if (path === '/api/reports' && method === 'GET') {
        return sendJson(res, 200, { reports: store.reportSummaries() });
      }

      const reportMatch = /^\/api\/reports\/([^/]+?)(\.csv)?$/.exec(path);
      if (reportMatch && method === 'GET') {
        const [, id, csv] = reportMatch;
        const report = store.getReport(id);
        if (!report) throw new HttpError(404, `Unknown report ${id}`);
        if (csv) {
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${report.id}.csv"`,
            'cache-control': 'no-store',
          });
          res.end(reportCsv(report));
          return;
        }
        return sendJson(res, 200, { report });
      }

      if (path === '/api/compare' && method === 'POST') {
        const body = asRecord(await readBody(req));
        const aId = str(body.a, 'a');
        const bId = str(body.b, 'b');
        const a = store.getReport(aId);
        const b = store.getReport(bId);
        if (!a) throw new HttpError(404, `Unknown report ${aId}`);
        if (!b) throw new HttpError(404, `Unknown report ${bId}`);
        const labelA = optStr(body.labelA) ?? `${a.datasetVersionId} · rev ${a.revisionNumber} · ${a.methodLabel}`;
        const labelB = optStr(body.labelB) ?? `${b.datasetVersionId} · rev ${b.revisionNumber} · ${b.methodLabel}`;
        return sendJson(res, 200, compareReports({ a, b, labelA, labelB }));
      }

      throw new HttpError(404, `No API route for ${method} ${path}`);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error('[server]', err);
      return sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    }
  };

  function requireDataset(s: Store): void {
    if (!s.hasVersions()) {
      throw new HttpError(503, 'No dataset version is pinned in the store. Run `npm run gen:demo` and restart the server.');
    }
  }

  function parseTaskConfig(body: Record<string, unknown>, s: Store): TaskConfig {
    requireDataset(s);
    const datasetVersionId = optStr(body.datasetVersionId) ?? s.latestVersionId();
    try {
      s.getVersion(datasetVersionId); // validates
    } catch {
      throw new HttpError(400, `Unknown datasetVersionId ${datasetVersionId}`);
    }
    const siteId = str(body.siteId, 'siteId');
    const eventId = str(body.eventId, 'eventId');
    const scope = body.scope === 'training_validation' ? 'training_validation' : 'event';
    const eventRevisionId = optStr(body.eventRevisionId);
    const validationDate = optStr(body.validationDate);
    if (scope === 'training_validation' && !validationDate) {
      throw new HttpError(400, 'validationDate is required when scope is training_validation');
    }
    const exclusions: ExclusionConfig = mergeExclusions(body.exclusions ?? {});
    if (body.autoPolicy && typeof body.autoPolicy === 'string') {
      exclusions.autoPolicy = body.autoPolicy as ExclusionConfig['autoPolicy'];
    }
    if (body.methodOverride !== undefined) {
      const mo = optStr(body.methodOverride);
      if (mo && !METHOD_IDS.includes(mo as MethodId)) throw new HttpError(400, `Unknown methodOverride ${mo}`);
      exclusions.methodOverride = (mo as MethodId | null) ?? null;
    }
    const label = optStr(body.label) ?? `${siteId} · ${eventId}${scope === 'training_validation' ? ` · validate ${validationDate}` : ''}`;
    return { label, scope, datasetVersionId, siteId, eventId, eventRevisionId, validationDate, exclusions };
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const clean = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(webRoot, clean);
    if (!file.startsWith(webRoot)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
    if (!existsSync(file)) {
      sendText(res, 404, 'Web assets not found. Run `npm run build` and make sure web/index.html exists.');
      return;
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    if (file.endsWith('index.html') && basePath) {
      // Behind a prefix the shell is also served for deep links such as
      // /dr/some/report. A <base> makes ./app.js and the API calls resolve
      // against the mount point instead of the deep path. At the origin root
      // relative URLs already work, so no <base> is injected there (it would
      // hijack in-page anchors like the skip link).
      const html = readFileSync(file, 'utf8').replace('<head>', `<head>\n    <base href="${basePath}/" />`);
      res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=300' });
    createReadStream(file).pipe(res);
  }

  return createServer((req, res) => {
    void handler(req, res);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createApp({ port, host });
  server.listen(port, host, () => {
    console.log(`Demand-response analysis server listening on http://${host}:${port}`);
    console.log(`Store: ${process.env.DR_STORE ?? join(projectRoot, 'data', 'store')}`);
  });
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, closing server.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

