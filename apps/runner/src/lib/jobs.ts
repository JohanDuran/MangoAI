import type { Response } from 'express';

// Claude work in flight per project (planning, applying a plan, regenerating a marker), so the
// editor can stop it on purpose instead of only by closing the connection.
export type JobTag = 'plan' | 'apply' | `regenerate:${string}`;

export interface Job {
  tag: JobTag;
  signal: AbortSignal;
  // True when the user pressed Stop, false when the run ended because the editor went away
  // (closed, reloaded, crashed). The first means "throw the work away", the second "it was interrupted".
  stoppedByUser: () => boolean;
  finish: () => void;
}

interface Entry {
  tag: JobTag;
  controller: AbortController;
  stoppedByUser: boolean;
}

const jobs = new Map<string, Set<Entry>>();

// Also aborts when the response closes before it finished (tab closed, app quit, request
// cancelled), so a Claude run nobody is waiting for does not keep running and spending.
export function startJob(projectId: string, tag: JobTag, res: Response): Job {
  const entry: Entry = { tag, controller: new AbortController(), stoppedByUser: false };
  let set = jobs.get(projectId);
  if (!set) jobs.set(projectId, (set = new Set()));
  set.add(entry);
  res.on('close', () => {
    if (!res.writableFinished) entry.controller.abort();
  });
  return {
    tag,
    signal: entry.controller.signal,
    stoppedByUser: () => entry.stoppedByUser,
    finish: () => {
      set!.delete(entry);
      if (set!.size === 0 && jobs.get(projectId) === set) jobs.delete(projectId);
    },
  };
}

// Stops the project's jobs matching the tag, or all of them. Returns how many were stopped.
export function stopJobs(projectId: string, tag?: JobTag): number {
  let stopped = 0;
  for (const entry of jobs.get(projectId) ?? []) {
    if (tag && entry.tag !== tag) continue;
    if (entry.controller.signal.aborted) continue;
    entry.stoppedByUser = true;
    entry.controller.abort();
    stopped++;
  }
  return stopped;
}

export function runningJobs(projectId: string): JobTag[] {
  return [...(jobs.get(projectId) ?? [])].map((e) => e.tag);
}
