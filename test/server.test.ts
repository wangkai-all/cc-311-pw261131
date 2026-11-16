import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildDataset } from '../src/ingest.js';
import { createApp } from '../src/server.js';
import { generateSyntheticDataset } from '../scripts/lib/generator.js';

function setupStore(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dr-server-'));
  for (const d of ['reports', 'tasks']) mkdirSync(join(root, d));
  const gen = generateSyntheticDataset({ seed: 11, startDate: '2026-07-20', endDate: '2026-08-31' });
  const v1 = buildDataset(gen.files as any, null, {
    id: 'ds-e2e-1',
    label: 'e2e v1',
    createdAtUtc: '2026-08-01T00:00:00Z',
    sourceLabel: 'e2e',
    notes: [],
    analysisStartDate: '2026-07-20',
    analysisEndDate: '2026-08-31',
    asOfLabel: 'v1',
  });
  writeFileSync(join(root, 'dataset-ds-e2e-1.json'), JSON.stringify(v1.dataset));
  writeFileSync(join(root, 'versions.json'), JSON.stringify({ latest: 'ds-e2e-1', order: ['ds-e2e-1'], diff: null, builtAt: '' }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = setupStore();
  const server = createApp({ storeRoot: root });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    cleanup();
  }
}

test('state bootstraps with sites, events, versions and defaults', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as any;
    assert.ok(s.sites.length >= 4);
    assert.ok(s.events.length >= 1);
    assert.equal(s.latestDatasetVersionId, 'ds-e2e-1');
    assert.ok(s.defaults.minActualCoverage > 0);
    assert.ok(s.disclaimer.includes('Synthetic'));
    assert.ok(Array.isArray(s.dataQuality.versions));
  });
});

test('a full task lifecycle: create, poll, report, csv, compare, restore', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'SITE-RIV', eventId: 'EV-2026-08-18', label: 'e2e run' }),
    });
    assert.equal(created.status, 202);
    const { task } = (await created.json()) as any;
    assert.ok(task.id);

    let final: any = null;
    for (let i = 0; i < 60; i++) {
      const poll = await fetch(`${base}/api/tasks/${task.id}`);
      const body = (await poll.json()) as any;
      if (!['queued', 'running'].includes(body.task.status)) {
        final = body.task;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(final, 'task did not finish in time');
    assert.equal(final.status, 'succeeded', final.error);
    assert.equal(final.reportIds.length, 1);

    const repRes = await fetch(`${base}/api/reports/${final.reportIds[0]}`);
    const { report } = (await repRes.json()) as any;
    assert.ok(['ok', 'insufficient_attribution'].includes(report.status));
    assert.equal(report.siteId, 'SITE-RIV');

    const csvRes = await fetch(`${base}/api/reports/${final.reportIds[0]}.csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') ?? '', /text\/csv/);
    const csv = await csvRes.text();
    assert.ok(csv.split('\n').length > 2);

    const cmp = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: final.reportIds[0], b: final.reportIds[0] }),
    });
    const cmpBody = (await cmp.json()) as any;
    assert.equal(cmpBody.comparability, 'exact');

    const restore = await fetch(`${base}/api/tasks/${task.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exclusions: { excludeHolidays: false } }),
    });
    assert.equal(restore.status, 201);
    const restored = (await restore.json()) as any;
    assert.equal(restored.task.restoredFromTaskId, task.id);
    assert.equal(restored.task.config.exclusions.excludeHolidays, false);
  });
});

test('bad input is rejected with a useful status, not a stack trace', async () => {
  await withServer(async (base) => {
    const noSite = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'EV-2026-08-18' }),
    });
    assert.equal(noSite.status, 400);
    assert.match(((await noSite.json()) as any).error, /siteId/);

    const badJson = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(badJson.status, 400);

    const unknown = await fetch(`${base}/api/reports/nope`);
    assert.equal(unknown.status, 404);

    const badVersion = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 'SITE-RIV', eventId: 'EV-2026-08-18', datasetVersionId: 'ds-nope' }),
    });
    assert.equal(badVersion.status, 400);
    assert.match(((await badVersion.json()) as any).error, /Unknown datasetVersionId/);
  });
});

test('unknown API paths 404 and non-API paths fall back to the app shell', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    const shell = await fetch(`${base}/some/deep/link`);
    assert.equal(shell.status, 200);
    const body = await shell.text();
    assert.ok(body.includes('<title>Demand Response Analysis'));
  });
});

test('an empty store reports unhealthy instead of a 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dr-empty-'));
  const server = createApp({ storeRoot: root });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const h = (await health.json()) as any;
    assert.equal(h.ok, false);
    assert.match(h.hint, /gen:demo/);

    for (const [path, init] of [
      ['/api/state', {}],
      ['/api/events', {}],
      ['/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"siteId":"SITE-RIV","eventId":"EV-2026-08-18"}' }],
    ] as const) {
      const res = await fetch(`${base}${path}`, init as RequestInit);
      assert.equal(res.status, 503, path);
      assert.match(((await res.json()) as any).error, /gen:demo/);
    }

    // The app shell must still load so the operator sees the message.
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(root, { recursive: true, force: true });
  }
});
