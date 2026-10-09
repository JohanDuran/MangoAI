import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
process.env.MANGO_PARALLEL_RUNS = '2';
const { withProjectLock, projectRunCounts } = await import('../src/lib/claude.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Starts a fake run that records when it began and ended, relative to the test start.
function tracker() {
  const t0 = Date.now();
  const log: string[] = [];
  let running = 0;
  let peak = 0;
  const run = (project: string, kind: string, name: string, ms = 60) =>
    withProjectLock(project, kind, async () => {
      running++;
      peak = Math.max(peak, running);
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      running--;
      return Date.now() - t0;
    });
  return { run, log, peak: () => peak };
}

test('runs of the same kind go side by side, up to the limit', async () => {
  const t = tracker();
  await Promise.all(['a', 'b', 'c', 'd'].map((n) => t.run('p1', 'gen', n)));
  assert.equal(t.peak(), 2);
  assert.equal(projectRunCounts('p1').active, 0);
});

test('a run of another kind waits for the running ones, and later runs queue behind it', async () => {
  const t = tracker();
  const first = t.run('p2', 'gen', 'a');
  const other = t.run('p2', 'other-skills', 'b');
  const later = t.run('p2', 'gen', 'c');
  await Promise.all([first, other, later]);
  assert.deepEqual(t.log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('projects do not wait for each other', async () => {
  const t = tracker();
  await Promise.all([t.run('p3', 'x', 'a'), t.run('p4', 'y', 'b')]);
  assert.deepEqual(t.log.slice(0, 2).sort(), ['start a', 'start b']);
});

test('a failing run frees its place', async () => {
  await assert.rejects(withProjectLock('p5', 'gen', async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await withProjectLock('p5', 'other', async () => 'ran'), 'ran');
});

test.after(cleanup);
