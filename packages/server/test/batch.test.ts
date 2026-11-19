import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/export.js';

// Each waitFor call returns a promise that the test settles by hand, so the test decides when a job moves on.
interface Pending {
  resolve: (j: Job | undefined) => void;
  reject: (e: Error) => void;
}

const { startExport, waitFor } = vi.hoisted(() => ({
  startExport: vi.fn<(dir: string) => Job>(),
  waitFor: vi.fn<(id: string, timeoutMs: number) => Promise<Job | undefined>>(),
}));
vi.mock('../src/export.js', () => ({ startExport, waitFor }));

let pending: Map<string, Pending[]>;
let batch: typeof import('../src/batch.js');

const job = (id: string, state: Job['state'], extra: Partial<Job> = {}): Job => ({
  id,
  state,
  progress: 0,
  message: state,
  ...extra,
});
const idOf = (dir: string) => `job-${path.basename(dir)}`;

/** Settle the oldest outstanding waitFor on the job for `dir`. */
async function answer(dir: string, j: Job | undefined | Error) {
  await vi.waitFor(() => expect(pending.get(idOf(dir))?.length ?? 0).toBeGreaterThan(0));
  const p = pending.get(idOf(dir))!.shift()!;
  if (j instanceof Error) p.reject(j);
  else p.resolve(j);
}

const settled = () => vi.waitFor(() => expect(batch.batchState().running).toBe(false));

const A = path.resolve('projects', 'alpha');
const B = path.resolve('projects', 'beta');
const C = path.resolve('projects', 'gamma');
const D = path.resolve('projects', 'delta');

beforeEach(async () => {
  pending = new Map();
  startExport.mockReset();
  waitFor.mockReset();
  startExport.mockImplementation((dir) => job(idOf(dir), 'planning'));
  waitFor.mockImplementation(
    (id) =>
      new Promise((resolve, reject) => {
        const list = pending.get(id) ?? [];
        list.push({ resolve, reject });
        pending.set(id, list);
      }),
  );
  // the queue is module-level state: load a fresh copy for every test
  vi.resetModules();
  batch = await import('../src/batch.js');
});

describe('addToBatch', () => {
  it('adds items in order with absolute paths and folder names', () => {
    const s = batch.addToBatch([path.join('projects', 'alpha'), B, path.join('projects', 'x', '..', 'gamma')]);
    expect(s.items.map((x) => ({ dir: x.dir, name: x.name }))).toEqual([
      { dir: A, name: 'alpha' },
      { dir: B, name: 'beta' },
      { dir: C, name: 'gamma' },
    ]);
    expect(s.items.every((x) => path.isAbsolute(x.dir))).toBe(true);
    expect(s.items.map((x) => x.state)).toEqual(['exporting', 'waiting', 'waiting']);
  });

  it('skips folders already waiting or exporting, matching the path case-insensitively', () => {
    batch.addToBatch([A, B]);
    const s = batch.addToBatch([A.toUpperCase(), B.toLowerCase(), C]);
    expect(s.items.map((x) => x.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(startExport).toHaveBeenCalledTimes(1);
  });

  it('allows re-adding a folder that is done or failed', async () => {
    batch.addToBatch([A, B]);
    await answer(A, job(idOf(A), 'done'));
    await answer(B, job(idOf(B), 'failed', { error: 'boom' }));
    await settled();
    expect(batch.batchState().items.map((x) => x.state)).toEqual(['done', 'failed']);

    const s = batch.addToBatch([A.toUpperCase(), B]);
    expect(s.items).toHaveLength(4);
    expect(s.items.slice(2).map((x) => x.state)).toEqual(['exporting', 'waiting']);
  });
});

describe('running the queue', () => {
  it('exports items one after another and copies output and took from the job', async () => {
    batch.addToBatch([A, B]);
    expect(startExport).toHaveBeenCalledTimes(1);
    expect(startExport).toHaveBeenLastCalledWith(A);

    // a progress update: still exporting, the message follows the job, the next item has not started
    await answer(A, job(idOf(A), 'rendering', { message: 'rendering 3/10' }));
    await vi.waitFor(() => expect(batch.batchState().items[0]!.message).toBe('rendering 3/10'));
    expect(batch.batchState().items.map((x) => x.state)).toEqual(['exporting', 'waiting']);
    expect(startExport).toHaveBeenCalledTimes(1);

    await answer(A, job(idOf(A), 'done', { output: 'out/alpha.mp4', took: 12.5 }));
    await vi.waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
    expect(startExport).toHaveBeenLastCalledWith(B);
    const [a, b] = batch.batchState().items;
    expect(a).toMatchObject({ state: 'done', output: 'out/alpha.mp4', took: 12.5, message: 'done' });
    expect(b!.state).toBe('exporting');
    expect(batch.batchState().running).toBe(true);

    await answer(B, job(idOf(B), 'done', { output: 'out/beta.mp4', took: 3 }));
    await settled();
    expect(batch.batchState().items[1]).toMatchObject({ state: 'done', output: 'out/beta.mp4', took: 3 });
  });

  it('marks failed, thrown and vanished jobs as failed and continues with the next item', async () => {
    startExport.mockImplementation((dir) => {
      if (dir === C) throw new Error('an export of this project is already running');
      return job(idOf(dir), 'planning');
    });
    batch.addToBatch([A, B, C, D]);

    await answer(A, job(idOf(A), 'failed', { error: 'ffmpeg crashed' })); // job ends failed
    await answer(B, undefined); // job disappears
    // C: startExport throws
    await answer(D, new Error('network down')); // waitFor throws
    await settled();

    const items = batch.batchState().items;
    expect(items.map((x) => x.state)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(items.map((x) => x.message)).toEqual([
      'ffmpeg crashed',
      'the export job went away',
      'an export of this project is already running',
      'network down',
    ]);
    expect(startExport).toHaveBeenCalledTimes(4);
  });

  it('uses the job message when a failed job has no error', async () => {
    batch.addToBatch([A, B]);
    await answer(A, job(idOf(A), 'failed', { message: 'render failed' }));
    await answer(B, job(idOf(B), 'done'));
    await settled();
    expect(batch.batchState().items.map((x) => [x.state, x.message])).toEqual([
      ['failed', 'render failed'],
      ['done', 'done'],
    ]);
  });
});

describe('clearBatch', () => {
  async function mixedQueue() {
    batch.addToBatch([A, B]);
    await answer(A, job(idOf(A), 'done'));
    await answer(B, job(idOf(B), 'failed', { error: 'x' }));
    await settled();
    batch.addToBatch([C, D]); // C starts exporting, D waits
    expect(batch.batchState().items.map((x) => x.state)).toEqual(['done', 'failed', 'exporting', 'waiting']);
  }

  it('removes only done and failed items by default', async () => {
    await mixedQueue();
    const s = batch.clearBatch();
    expect(s.items.map((x) => [x.name, x.state])).toEqual([
      ['gamma', 'exporting'],
      ['delta', 'waiting'],
    ]);
  });

  it('with all, also removes waiting items but keeps the one exporting', async () => {
    await mixedQueue();
    const s = batch.clearBatch(true);
    expect(s.items.map((x) => [x.name, x.state])).toEqual([['gamma', 'exporting']]);
  });
});
