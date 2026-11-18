// Export: render once at the end, re-rendering only what changed. The plan shows which parts are already
// rendered (green on the timeline's cache bar) and which comps need a HyperFrames render.
import type { Check } from '@mangoai/core';
import { useEffect, useState } from 'react';
import { api, type ExportJob } from '../api';
import type { Player } from '../engine/player';
import { recent, studio, useStudio } from '../store';
import { timecode } from './Transport';

interface Plan {
  segments: { t0: number; t1: number; cached: boolean; key: string }[];
  comps: { clip: string; comp: string; cached: boolean }[];
  output: string;
  estimate: string;
  checks?: Check[];
}

/** Common loudness targets: [LUFS, where it's used]. */
const LOUDNESS: [number, string][] = [
  [-14, 'YouTube, TikTok, Instagram, Spotify'],
  [-16, 'Apple, podcasts'],
  [-18, 'quieter, more headroom'],
  [-23, 'broadcast (EBU R128)'],
];

const ICON: Record<Check['level'], string> = { error: '⛔', warn: '⚠', info: 'ℹ' };

/** Before exporting: what looks wrong, each with a jump to where it is. */
function Checks({ checks, player }: { checks: Check[]; player: Player | null }) {
  if (!checks.length)
    return (
      <div className="checks ok small" title="Missing files, black gaps, muted or hidden tracks, captions, open requests, sound">
        ✓ Checks passed
      </div>
    );
  const errors = checks.filter((c) => c.level === 'error').length;
  return (
    <div className="checks small">
      <b title="Things that are probably mistakes. Nothing here stops the export">
        Before you export ({errors ? `${errors} problem${errors > 1 ? 's' : ''}, ` : ''}
        {checks.length - errors} note{checks.length - errors === 1 ? '' : 's'})
      </b>
      <ul>
        {checks.map((c, i) => (
          <li key={i} className={c.level}>
            <span>{ICON[c.level]}</span> {c.message}{' '}
            {(c.t !== undefined || c.clip) && (
              <button
                className="link"
                onClick={() => {
                  if (c.t !== undefined) player?.seek(c.t);
                  if (c.clip) studio.select(c.clip);
                }}
                title="Go there"
              >
                go
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BatchItem {
  dir: string;
  name: string;
  state: 'waiting' | 'exporting' | 'done' | 'failed';
  message?: string;
  output?: string;
  took?: number;
}

/** Export several projects one after another (e.g. a week of Shorts overnight). */
function Batch() {
  const s = useStudio();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const here = s.opened?.dir ?? '';
  const choices = [...new Set([here, ...recent()])].filter(Boolean);
  const refresh = () =>
    api.get<{ running: boolean; items: BatchItem[] }>('/api/export/batch').then((r) => {
      setItems(r.items);
      setRunning(r.running);
    }, () => {});
  useEffect(() => {
    if (!open) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [open]);
  const add = async () => {
    if (pick.has(here) && studio.dirty && !(await studio.save())) return;
    await api.post('/api/export/batch', { dirs: [...pick] }).catch((e: Error) => studio.flash(e.message, true));
    setPick(new Set());
    void refresh();
  };
  const ICONS = { waiting: '○', exporting: '◐', done: '●', failed: '✕' } as const;
  return (
    <div className="batch">
      <button className="link small" onClick={() => setOpen(!open)} title="Export several projects one after another">
        {open ? '▾' : '▸'} Batch export{running ? ' (running)' : items.length ? ` (${items.filter((x) => x.state === 'done').length}/${items.length} done)` : ''}
      </button>
      {open && (
        <div className="small">
          <div className="muted">Pick projects to export one after another. You can close this tab; the export keeps going while the editor runs.</div>
          <ul className="batch-pick">
            {choices.map((d) => (
              <li key={d}>
                <label title={d}>
                  <input
                    type="checkbox"
                    checked={pick.has(d)}
                    onChange={(e) => {
                      const n = new Set(pick);
                      if (e.target.checked) n.add(d);
                      else n.delete(d);
                      setPick(n);
                    }}
                  />{' '}
                  {d.split(/[\\/]/).slice(-2).join('/')}
                  {d === here ? ' (this one)' : ''}
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <button disabled={!pick.size} onClick={() => void add()} title="Add the ticked projects to the queue; it starts right away">
              Export {pick.size || ''} in a row
            </button>
            {items.some((x) => x.state === 'done' || x.state === 'failed') && (
              <button className="ghost" onClick={() => void api.post('/api/export/batch', { clear: 'done' }).then(refresh)} title="Remove finished items from the list">
                Clear finished
              </button>
            )}
            {items.some((x) => x.state === 'waiting') && (
              <button className="ghost" onClick={() => void api.post('/api/export/batch', { clear: 'all' }).then(refresh)} title="Remove the ones that haven't started (the current export finishes)">
                Cancel waiting
              </button>
            )}
          </div>
          {items.length > 0 && (
            <ul className="batch-items">
              {items.map((it, i) => (
                <li key={i} className={it.state} title={it.output ?? it.dir}>
                  {ICONS[it.state]} <b>{it.name}</b> <span className="muted">{it.state === 'done' ? `done${it.took ? ` in ${Math.round(it.took)} s` : ''}` : it.message ?? it.state}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function ExportPanel({ player }: { player: Player | null }) {
  const s = useStudio();
  const dir = s.opened?.dir ?? '';
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const job = s.exportJob;
  const rev = s.editor?.project.revision ?? 0;

  const load = () =>
    api.get<Plan>(`/api/export/plan?${new URLSearchParams({ dir })}`).then(
      (p) => {
        setPlan(p);
        setErr(null);
        studio.cachePlan = p.segments;
        studio.emit();
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    if (dir) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, rev, job?.state]);

  const start = async (range?: [number, number]) => {
    if (studio.dirty && !(await studio.save())) return;
    try {
      await api.post<{ job: ExportJob }>('/api/export', { dir, ...(range && { range }) });
    } catch (e) {
      studio.flash((e as Error).message, true);
    }
  };
  const otio = async () => {
    if (studio.dirty && !(await studio.save())) return;
    try {
      const r = await api.post<{ path: string }>('/api/export/otio', { dir });
      studio.flash(`Wrote ${r.path}`);
    } catch (e) {
      studio.flash((e as Error).message, true);
    }
  };
  const fps = s.editor?.project.fps ?? 30;
  const busy = job && (job.state === 'planning' || job.state === 'rendering');
  const todo = plan ? plan.segments.filter((x) => !x.cached).length : 0;
  const compsTodo = plan ? plan.comps.filter((x) => !x.cached).length : 0;
  return (
    <div className="panel side-body">
      <div className="panel-body">
        {err && <div className="error-text small">{err}</div>}
        {plan?.checks && <Checks checks={plan.checks} player={player} />}
        {plan && (
          <>
            <dl>
              <dt>Output</dt>
              <dd className="small">{plan.output}</dd>
              <dt>Picture</dt>
              <dd>
                {plan.segments.length - todo} of {plan.segments.length} parts already rendered
              </dd>
              <dt>Comps</dt>
              <dd>{plan.comps.length ? `${plan.comps.length - compsTodo} of ${plan.comps.length} cached` : 'none'}</dd>
              <dt>Estimate</dt>
              <dd>{plan.estimate}</dd>
            </dl>
            <ul className="segments small">
              {plan.segments.map((seg) => (
                <li key={seg.key} className={seg.cached ? 'cached' : 'stale'}>
                  <button className="ghost tc" onClick={() => player?.seek(seg.t0)} title="Go to this part">
                    {timecode(seg.t0, fps)}–{timecode(seg.t1, fps)}
                  </button>{' '}
                  {seg.cached ? 'rendered' : 'will render'}
                </li>
              ))}
            </ul>
          </>
        )}
        <Batch />
        <div className="row small loudness">
          <span title="The export measures the whole mix and sets one gain so it lands at this loudness (then a limiter catches peaks)">Loudness</span>
          <select
            value={String(s.editor?.project.master?.loudness ?? -14)}
            title="Target loudness of the export"
            onChange={(e) => {
              const v = Number(e.target.value);
              studio.apply([{ op: 'set_master', set: { loudness: v === -14 ? null : v } }], `loudness target ${v} LUFS`);
            }}
          >
            {LOUDNESS.map(([v, label]) => (
              <option key={v} value={v}>
                {v} LUFS · {label}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button className="primary" disabled={!!busy} onClick={() => void start()} title="Render the whole video; parts already rendered are reused">
            {busy ? 'Exporting…' : 'Export'}
          </button>
          <button disabled={!!busy || !s.range} onClick={() => s.range && void start(s.range)} title="Render just the I/O range to check it exactly">
            Render range
          </button>
          <button onClick={() => void otio()} title="OpenTimelineIO, to finish in DaVinci Resolve">
            Export .otio
          </button>
        </div>
        {job && (
          <div className={`job ${job.state}`}>
            <div className="bar">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <div className="small">{job.message}</div>
            {job.output && job.state === 'done' && (
              <div className="small">
                <a href={api.fileUrl(job.output, dir)} target="_blank" rel="noreferrer">
                  {job.output.split(/[\\/]/).pop()}
                </a>{' '}
                · {job.took?.toFixed(1)} s{job.reused !== undefined ? ` · reused ${job.reused}, rendered ${job.rendered}` : ''}
              </div>
            )}
            {job.error && <pre className="error-text small">{job.error}</pre>}
          </div>
        )}
        <p className="muted small">
          Saves first. Each part between edit points is cached by what's in it, so after a small change only that part
          and any changed comp render again; the rest is joined from cache.
        </p>
      </div>
    </div>
  );
}
