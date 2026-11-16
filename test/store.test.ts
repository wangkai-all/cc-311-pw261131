import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDataset } from '../src/ingest.js';
import { DEFAULT_EXCLUSIONS } from '../src/baseline.js';
import { Store } from '../src/store.js';
import { generateSyntheticDataset } from '../scripts/lib/generator.js';

/** Minimal but real CSV bundle, run through the actual ingest path. */
const FILES = (() => {
  const gen = generateSyntheticDataset({ seed: 7, startDate: '2026-07-20', endDate: '2026-08-31' });
  return gen.files ?? [];
})();

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dr-store-'));
  for (const d of ['reports', 'tasks']) mkdirSync(join(root, d));
  const v1 = buildDataset(FILES as any, null, {
    id: 'ds-test-1',
    label: 'v1',
    createdAtUtc: '2026-08-01T00:00:00Z',
    sourceLabel: 'test',
    notes: [],
    analysisStartDate: '2026-07-20',
    analysisEndDate: '2026-08-31',
    asOfLabel: 'v1',
  });
  writeFileSync(join(root, 'dataset-ds-test-1.json'), JSON.stringify(v1.dataset));
  writeFileSync(
    join(root, 'versions.json'),
    JSON.stringify({ latest: 'ds-test-1', order: ['ds-test-1'], diff: null, builtAt: new Date().toISOString() }),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a task runs, persists a report, and can be listed', () => {
  const { root, cleanup } = makeRoot();
  try {
    const store = new Store({ root });
    const task = store.createTask({
      config: {
        label: 'Riverside dispatch',
        scope: 'event',
        datasetVersionId: 'ds-test-1',
        siteId: 'SITE-RIV',
        eventId: 'EV-2026-08-18',
        eventRevisionId: null,
        validationDate: null,
        exclusions: { ...DEFAULT_EXCLUSIONS, bootstrapReplicates: 150 },
      },
    });
    const done = store.runTask(task.id)!;
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(done.progress, 1);
    assert.equal(done.reportIds.length, 1);
    assert.ok(done.log.some((l) => l.step === 'done'));
    assert.ok(store.getReport(done.reportIds[0]));
    assert.equal(store.reportSummaries().length, 1);
    // Task and report are on disk before the call returns.
    assert.ok(readFileSync(join(root, 'tasks', `${done.id}.json`), 'utf8').includes('succeeded'));
  } finally {
    cleanup();
  }
});

test('restoring a task creates a new task that keeps the pinned inputs', () => {
  const { root, cleanup } = makeRoot();
  try {
    const store = new Store({ root });
    const exclusions = { ...DEFAULT_EXCLUSIONS, excludeHolidays: true, bootstrapReplicates: 120 };
    const original = store.createTask({
      config: {
        label: 'original',
        scope: 'event',
        datasetVersionId: 'ds-test-1',
        siteId: 'SITE-RIV',
        eventId: 'EV-2026-08-18',
        eventRevisionId: null,
        validationDate: null,
        exclusions,
      },
    });
    store.runTask(original.id);

    const restored = store.restoreTask(original.id)!;
    assert.notEqual(restored.id, original.id);
    assert.equal(restored.restoredFromTaskId, original.id);
    assert.equal(restored.config.datasetVersionId, 'ds-test-1');
    assert.deepEqual(restored.config.exclusions, exclusions);
    assert.ok(restored.restoreNote?.includes(original.id));
    // Restoring must not mutate history.
    assert.equal(store.getTask(original.id)!.status, 'succeeded');

    // Overrides are allowed and are recorded on the new task only.
    const tweaked = store.restoreTask(original.id, { exclusions: { ...exclusions, excludeHolidays: false } })!;
    assert.equal(tweaked.config.exclusions.excludeHolidays, false);
    assert.equal(store.getTask(original.id)!.config.exclusions.excludeHolidays, true);
  } finally {
    cleanup();
  }
});

test('a task left running by a dead process is recovered as interrupted', () => {
  const { root, cleanup } = makeRoot();
  try {
    const store = new Store({ root });
    const t = store.createTask({
      config: {
        label: 'doomed',
        scope: 'event',
        datasetVersionId: 'ds-test-1',
        siteId: 'SITE-RIV',
        eventId: 'EV-2026-08-18',
        eventRevisionId: null,
        validationDate: null,
        exclusions: DEFAULT_EXCLUSIONS,
      },
    });
    // Simulate a crash: the file says running, but the process is gone.
    const raw = JSON.parse(readFileSync(join(root, 'tasks', `${t.id}.json`), 'utf8'));
    raw.status = 'running';
    raw.progress = 0.4;
    writeFileSync(join(root, 'tasks', `${t.id}.json`), JSON.stringify(raw));

    const restarted = new Store({ root });
    const recovered = restarted.getTask(t.id)!;
    assert.equal(recovered.status, 'interrupted');
    // Progress keeps the last checkpoint: an interrupted task is not fake-complete.
    assert.equal(recovered.progress, 0.4);
    assert.ok(recovered.error?.includes('Restore'));
    assert.ok(recovered.interruptedAt !== null && recovered.interruptedAt !== undefined);

    const restored = restarted.restoreTask(t.id)!;
    restarted.runTask(restored.id);
    assert.equal(restarted.getTask(restored.id)!.status, 'succeeded');
  } finally {
    cleanup();
  }
});

test('an unknown site fails the task instead of producing an empty report', () => {
  const { root, cleanup } = makeRoot();
  try {
    const store = new Store({ root });
    const t = store.createTask({
      config: {
        label: 'bad site',
        scope: 'event',
        datasetVersionId: 'ds-test-1',
        siteId: 'SITE-NOPE',
        eventId: 'EV-2026-08-18',
        eventRevisionId: null,
        validationDate: null,
        exclusions: DEFAULT_EXCLUSIONS,
      },
    });
    const done = store.runTask(t.id)!;
    assert.equal(done.status, 'failed');
    assert.ok(done.error?.includes('SITE-NOPE'));
    assert.equal(done.reportIds.length, 0);
  } finally {
    cleanup();
  }
});

test('cancelling a queued task is recorded and cannot then run', () => {
  const { root, cleanup } = makeRoot();
  try {
    const store = new Store({ root });
    const t = store.createTask({
      config: {
        label: 'cancel me',
        scope: 'event',
        datasetVersionId: 'ds-test-1',
        siteId: 'SITE-RIV',
        eventId: 'EV-2026-08-18',
        eventRevisionId: null,
        validationDate: null,
        exclusions: DEFAULT_EXCLUSIONS,
      },
    });
    store.cancelTask(t.id);
    assert.equal(store.getTask(t.id)!.status, 'cancelled');
    store.runTask(t.id);
    assert.equal(store.getTask(t.id)!.status, 'cancelled');
  } finally {
    cleanup();
  }
});
