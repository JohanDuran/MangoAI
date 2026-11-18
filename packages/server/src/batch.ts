// Batch export: a queue of project folders exported one after another (overnight renders). One queue per
// server; it lives in memory, so it ends with the server.
import path from 'node:path';
import { startExport, waitFor } from './export.js';

export interface BatchItem {
  dir: string;
  name: string;
  state: 'waiting' | 'exporting' | 'done' | 'failed';
  message?: string;
  output?: string;
  took?: number;
}

const queue: BatchItem[] = [];
let running = false;

export function batchState() {
  return { running, items: queue };
}

export function addToBatch(dirs: string[]) {
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (queue.some((x) => x.dir.toLowerCase() === abs.toLowerCase() && (x.state === 'waiting' || x.state === 'exporting'))) continue;
    queue.push({ dir: abs, name: path.basename(abs), state: 'waiting' });
  }
  void run();
  return batchState();
}

/** Drop finished items (and, with `all`, the waiting ones too). */
export function clearBatch(all = false) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const s = queue[i]!.state;
    if (s === 'done' || s === 'failed' || (all && s === 'waiting')) queue.splice(i, 1);
  }
  return batchState();
}

async function run() {
  if (running) return;
  running = true;
  try {
    for (let it = queue.find((x) => x.state === 'waiting'); it; it = queue.find((x) => x.state === 'waiting')) {
      it.state = 'exporting';
      it.message = 'starting';
      try {
        const job = startExport(it.dir);
        // follow its progress until it ends (a long render can take a while)
        for (;;) {
          const j = await waitFor(job.id, 2000);
          if (!j) throw new Error('the export job went away');
          it.message = j.message;
          if (j.state === 'done') {
            it.state = 'done';
            if (j.output) it.output = j.output;
            if (j.took !== undefined) it.took = j.took;
            break;
          }
          if (j.state === 'failed') throw new Error(j.error ?? j.message);
        }
      } catch (e) {
        it.state = 'failed';
        it.message = (e as Error).message;
      }
    }
  } finally {
    running = false;
  }
}
