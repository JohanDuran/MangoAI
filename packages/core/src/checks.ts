// Before an export: things that are probably mistakes (missing files, black gaps, open requests, captions
// off). Used by the editor's Export tab and by Claude's export_plan; nothing here blocks an export.
import type { Resolved } from './resolve.js';
import type { Project } from './schema.js';

export interface Check {
  level: 'error' | 'warn' | 'info';
  message: string;
  /** Where to look: a time on the timeline and/or a clip. */
  t?: number;
  clip?: string;
}

export interface CheckOptions {
  /** Clip srcs whose files don't exist. */
  missing?: ReadonlySet<string>;
}

export function checkProject(p: Project, r: Resolved, opts: CheckOptions = {}): Check[] {
  const out: Check[] = [];
  for (const pr of r.problems) out.push({ level: 'error', message: `${pr.path}: ${pr.message}` });

  // media files that aren't there: one line per file, pointing at its first clip
  const bySrc = new Map<string, { first: string; t?: number; n: number }>();
  for (const t of p.tracks)
    for (const c of t.clips)
      if (c.type === 'media' && opts.missing?.has(c.src)) {
        const rc = r.clips.get(c.id);
        const cur = bySrc.get(c.src);
        if (!cur) bySrc.set(c.src, { first: c.id, n: 1, ...(rc && { t: rc.start }) });
        else {
          cur.n++;
          if (rc && (cur.t === undefined || rc.start < cur.t)) {
            cur.t = rc.start;
            cur.first = c.id;
          }
        }
      }
  for (const [src, x] of bySrc) {
    const file = src.split(/[\\/]/).pop();
    out.push({ level: 'error', message: `Missing file ${file} (${x.n} clip${x.n > 1 ? 's' : ''}; looked for ${src})`, clip: x.first, ...(x.t !== undefined && { t: x.t }) });
  }

  // black gaps: times where no visible video clip covers the frame
  const spans: [number, number][] = [];
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      const rc = r.clips.get(c.id);
      if (rc && rc.end !== null) spans.push([rc.start, rc.end]);
    }
  }
  if (p.tracks.some((t) => t.kind === 'video')) {
    spans.sort((a, b) => a[0] - b[0]);
    const frame = 1 / p.fps;
    let at = 0;
    for (const [a, b] of spans) {
      if (a - at > frame) out.push({ level: 'warn', message: `${(a - at).toFixed(2)} s of black at ${at.toFixed(2)} s (no video clip)`, t: at });
      at = Math.max(at, b);
    }
    if (r.end - at > frame) out.push({ level: 'warn', message: `${(r.end - at).toFixed(2)} s of black at the end (${at.toFixed(2)} s)`, t: at });
  }

  // tracks left out of the export
  for (const t of p.tracks) {
    if (!t.clips.length) continue;
    if (t.muted) out.push({ level: 'info', message: `Track ${t.id}${t.name ? ` (${t.name})` : ''} is muted: it won't be heard` });
    if (t.hidden) out.push({ level: 'info', message: `Track ${t.id}${t.name ? ` (${t.name})` : ''} is hidden: it won't be seen` });
  }
  const caps = p.tracks.filter((t) => t.kind === 'captions');
  if (caps.length && caps.every((t) => t.enabled === false)) out.push({ level: 'warn', message: 'Captions are off' });

  // requests nobody finished
  for (const q of p.requests ?? [])
    if (q.status === 'open' || q.status === 'working')
      out.push({ level: 'warn', message: `Request ${q.id} is still ${q.status === 'open' ? 'open' : 'being worked on'}: ${q.text}`, ...(q.range ? { t: q.range[0] } : q.t !== undefined ? { t: q.t } : {}) });

  if (!p.tracks.some((t) => t.kind === 'audio' && !t.muted && t.clips.length)) out.push({ level: 'warn', message: 'There is no sound' });
  return out;
}
