// Right panel: the selected clip's fields (editable), or the project when nothing is selected.
// Every edit is an op, so it's undoable and shows up in "what changed" for Claude after you Save.
import {
  deleteClips,
  linkTime,
  rippleDeleteClips,
  setFades,
  gainKeyAt,
  setGain,
  splitAt,
  unlinkTime,
  type Clip,
  type MediaClip,
  type Op,
  type TimeExpr,
  type Track,
} from '@mangoai/core';
import { useEffect, useState } from 'react';
import type { Player } from '../engine/player';
import { keyed, STYLES } from '../engine/look';
import { studio, useStudio } from '../store';
import { timecode } from './Transport';

/** A text box that commits on Enter or blur. Numbers stay numbers; empty clears the field (null). */
export function Field({
  value,
  onCommit,
  placeholder,
  wide,
  title,
}: {
  value: string | number | undefined | null;
  onCommit: (v: string | number | null) => void;
  placeholder?: string;
  wide?: boolean;
  title?: string;
}) {
  const shown = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text === shown) return;
    const t = text.trim();
    onCommit(t === '' ? null : /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t);
  };
  return (
    <input
      className={wide ? 'wide' : ''}
      value={text}
      placeholder={placeholder}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(shown);
        e.stopPropagation();
      }}
    />
  );
}

function set(id: string, fields: Record<string, unknown>, label?: string) {
  studio.apply([{ op: 'update_clip', id, set: fields }], label);
}

/** The word nearest to t (within 0.4 s), for "link to word". */
function wordNear(t: number): { i: number; text: string; at: number } | null {
  const w = studio.words;
  if (!w || !w.words.length) return null;
  const i = w.firstAfter(t - 0.4);
  let best: { i: number; text: string; at: number } | null = null;
  for (let k = i; k < Math.min(w.words.length, i + 6); k++) {
    const word = w.words[k]!;
    if (Math.abs(word.s - t) <= 0.4 && (!best || Math.abs(word.s - t) < Math.abs(best.at - t))) best = { i: k, text: word.w, at: word.s };
  }
  return best;
}

function TimeRow({ clip, edge, label, player }: { clip: Clip; edge: 'start' | 'end'; label: string; player: Player | null }) {
  const r = studio.resolved()?.clips.get(clip.id);
  const fps = studio.editor?.project.fps ?? 30;
  const v = edge === 'start' ? r?.start : r?.end;
  const expr = clip[edge] as TimeExpr | undefined;
  const linked = typeof expr === 'string';
  const near = v !== undefined && v !== null && !linked ? wordNear(edge === 'start' ? v + (clip.pivot ?? 0) : v) : null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <div className="row">
          <button className="ghost tc" onClick={() => v != null && player?.seek(v)} title="Go there">
            {v != null ? timecode(v, fps) : edge === 'end' ? 'end of media' : '—'}
          </button>
          <Field value={expr} onCommit={(x) => set(clip.id, { [edge]: x }, `set ${edge} of ${clip.id}`)} title="Seconds or an expression: word:so, word:so#2.end, s02.start + 0.3, an anchor name" />
        </div>
        {linked ? (
          <div className="small muted">
            🔗 follows <code>{expr}</code>{' '}
            <button className="link" onClick={() => studio.run((e) => unlinkTime(e, clip.id, edge), `unlinked ${clip.id} ${edge}`)} title="Keep the current time as a plain number; it stops following">unlink</button>
          </div>
        ) : near && edge === 'start' ? (
          <div className="small muted">
            <button className="link" onClick={() => studio.run((e) => linkTime(e, clip.id, edge, studio.words!.refOf(near.i)), `linked ${clip.id} to "${near.text}"`)} title="Tie this clip to the word, so it moves with it when the voice is redone">
              link to the word “{near.text}”
            </button>{' '}
            so it follows a re-voice
          </div>
        ) : null}
      </dd>
    </>
  );
}

export function Inspector({ player }: { player: Player | null }) {
  const s = useStudio();
  const r = s.resolved();
  if (!r || !s.editor) return <aside className="inspector panel" />;
  if (s.selected.length > 1) return <MultiInspector ids={s.selected} />;
  const sel = s.selection ? s.clip(s.selection) : null;
  if (!sel) return <ProjectInspector player={player} />;
  return <ClipInspector clip={sel.clip} track={sel.track} player={player} />;
}

function ClipInspector({ clip, track, player }: { clip: Clip; track: Track; player: Player | null }) {
  const s = useStudio();
  const r = s.resolved()!;
  const rc = r.clips.get(clip.id);
  const [json, setJson] = useState('');
  const { id, type, ...fields } = clip;
  const asJson = JSON.stringify(fields, null, 1);
  useEffect(() => setJson(asJson), [asJson]);
  const problems = r.problems.filter((p) => {
    const m = /^tracks\.(\d+)\.clips\.(\d+)/.exec(p.path);
    return m && s.editor!.project.tracks[Number(m[1])]?.clips[Number(m[2])]?.id === id;
  });
  const applyJson = () => {
    try {
      const next = JSON.parse(json) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(fields), ...Object.keys(next)])) {
        const a = JSON.stringify((fields as Record<string, unknown>)[k]);
        const b = JSON.stringify(next[k]);
        if (a !== b) patch[k] = next[k] === undefined ? null : next[k];
      }
      if (Object.keys(patch).length) set(id, patch, `edited ${id} fields`);
    } catch (e) {
      studio.flash(`Not valid JSON: ${(e as Error).message}`, true);
    }
  };
  const defaultGain = track.role === 'sfx' ? -10 : track.role === 'music' ? -22 : 0;
  const t = player?.time() ?? 0;
  const inside = rc && rc.end !== null && t > rc.start && t < rc.end;

  return (
    <aside className="inspector panel">
      <div className="panel-head">
        <span>
          {type} · {id}
        </span>
        <button className="ghost" onClick={() => studio.select(null)} title="Deselect (Esc)">✕</button>
      </div>
      <div className="panel-body">
        <div className="actions">
          <button disabled={!inside} onClick={() => studio.run((e) => splitAt(e, player!.time(), [id]), `split ${id}`)} title="Split at the playhead (S)">Split</button>
          <button onClick={() => studio.run((e) => deleteClips(e, [id]), `deleted ${id}`)} title="Delete">Delete</button>
          <button onClick={() => studio.run((e) => rippleDeleteClips(e, [id]), `ripple-deleted ${id}`)} title="Delete and close the gap (Shift+Del)">Ripple delete</button>
          <button onClick={() => duplicate([id])} title="Duplicate after itself (Ctrl+D)">Duplicate</button>
        </div>
        {problems.map((p) => (
          <div key={p.path} className="error-text small">⚠ {p.message}</div>
        ))}
        <dl>
          <dt title="The track this clip is on">Track</dt>
          <dd>
            {track.id} {track.name ? `· ${track.name}` : ''} {track.locked ? '🔒' : ''}
          </dd>
          <dt title="A name for the clip, shown on the timeline">Label</dt>
          <dd>
            <Field value={clip.label} onCommit={(v) => set(id, { label: v === null ? null : String(v) })} placeholder="(none)" />
          </dd>
          <TimeRow clip={clip} edge="start" label="Starts" player={player} />
          <TimeRow clip={clip} edge="end" label="Ends" player={player} />
          {clip.pivot !== undefined && (
            <>
              <dt title="The moment in the sound that lands exactly on the clip's start">Hit at</dt>
              <dd>
                <Field value={clip.pivot} onCommit={(v) => set(id, { pivot: v })} title="Seconds into the sound that land exactly on its start (the loudest point)" /> s into the sound
              </dd>
            </>
          )}
          {clip.type === 'media' && (
            <>
              <dt title="The media file this clip plays">Source</dt>
              <dd className="small" title={clip.src}>{clip.src.split('/').pop()}</dd>
              <dt title="Where in the source file the clip starts playing">In</dt>
              <dd>
                <Field value={clip.in} placeholder={rc?.in?.toFixed(3) ?? '0'} onCommit={(v) => set(id, { in: v })} title="Seconds into the source file (or an expression)" /> s{' '}
                {rc?.speed !== undefined && rc.speed !== 1 && <span className="muted">· ×{rc.speed.toFixed(3)}</span>}
              </dd>
              <dt title="Playback speed: 1 is normal, 2 is twice as fast, 0.5 is half">Speed</dt>
              <dd>
                <Field value={clip.speed} placeholder="1" onCommit={(v) => set(id, { speed: v, speedTo: null })} title="1 = normal speed" />
              </dd>
              {(track.kind === 'audio' || s.opened?.media[clip.src]?.hasAudio) && (
                <>
                  <dt title="Volume change in dB: 0 is unchanged, -6 about half as loud">Gain</dt>
                  <dd className="row">
                    <input
                      type="range"
                      min={-40}
                      max={12}
                      step={0.5}
                      value={clip.gain ?? defaultGain}
                      title={`${clip.gain ?? defaultGain} dB`}
                      onChange={(e) => studio.apply(setGain([id], Number(e.target.value)), `gain ${id}`)}
                    />
                    <Field value={clip.gain} placeholder={`${defaultGain}`} onCommit={(v) => studio.apply(setGain([id], v === null ? null : Number(v)), `gain ${id}`)} /> dB
                  </dd>
                </>
              )}
              <dt title="Seconds of fade at the start (in) and end (out)">Fades</dt>
              <dd className="row">
                in <Field value={clip.fadeIn} placeholder="0" onCommit={(v) => studio.run((e) => setFades(e, [id], v === null ? null : Number(v)), `fade in ${id}`)} />
                out <Field value={clip.fadeOut} placeholder="0" onCommit={(v) => studio.run((e) => setFades(e, [id], undefined, v === null ? null : Number(v)), `fade out ${id}`)} /> s
              </dd>
              {track.kind === 'audio' && (
                <>
                  <dt title="Repeat the sound until the clip ends">Loop</dt>
                  <dd>
                    <input type="checkbox" title="Repeat the sound until the clip ends" checked={!!clip.loop} onChange={(e) => set(id, { loop: e.target.checked || null })} />
                  </dd>
                </>
              )}
              {track.kind === 'video' && (
                <>
                  <dt title="Where the picture sits in the vertical frame: its width (w) and the height of its centre (y), in pixels of a 1080-wide frame">Card</dt>
                  <dd className="row">
                    w <Field value={clip.cardW} placeholder="1080" onCommit={(v) => set(id, { cardW: v })} title="Card width in pixels (1080 = full width)" />
                    y <Field value={clip.cy} placeholder="900" onCommit={(v) => set(id, { cy: v })} title="Height of the card's centre in pixels from the top" />
                  </dd>
                  <dt title="Blur and darken the picture, so text on top stands out">Dim</dt>
                  <dd>
                    <input type="checkbox" title="Blur and darken the picture" checked={!!clip.dim} onChange={(e) => set(id, { dim: e.target.checked || null })} />
                  </dd>
                  <dt title="Zoom and pan over time: each key sets the zoom and the point it centres on, eased between keys">Zoom keys</dt>
                  <dd>
                    <ZoomKeys clip={clip} player={player} />
                  </dd>
                </>
              )}
              {track.kind === 'audio' && (
                <>
                  <dt title="Volume over time: each key is a level in dB at a time in the clip; it moves in a straight line between keys">Volume keys</dt>
                  <dd>
                    <GainKeys clip={clip} player={player} />
                  </dd>
                </>
              )}
            </>
          )}
          {clip.type === 'title' && (
            <>
              <dt title="What the title says">Text</dt>
              <dd>
                <textarea
                  rows={2}
                  defaultValue={clip.text ?? ''}
                  key={`${id}:${clip.text}`}
                  disabled={!!clip.runs}
                  title={clip.runs ? 'This title has coloured runs: edit them in Fields below' : ''}
                  onBlur={(e) => e.target.value !== (clip.text ?? '') && set(id, { text: e.target.value || null }, `text of ${id}`)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </dd>
              <dt title="The look of the title (font, size, colours)">Style</dt>
              <dd>
                <select title="Title style" value={clip.style ?? 'Cap'} onChange={(e) => set(id, { style: e.target.value })}>
                  {[...Object.keys(STYLES), 'Shape'].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </dd>
              <dt title="Centre of the title in pixels (x from the left, y from the top)">Position</dt>
              <dd className="row">
                x <Field value={clip.pos?.[0]} placeholder="540" onCommit={(v) => set(id, { pos: [Number(v ?? 540), clip.pos?.[1] ?? 960] })} />
                y <Field value={clip.pos?.[1]} placeholder="960" onCommit={(v) => set(id, { pos: [clip.pos?.[0] ?? 540, Number(v ?? 960)] })} />
              </dd>
              <dt title="Font size in pixels; empty uses the style's size">Size</dt>
              <dd>
                <Field value={clip.fs} placeholder="style default" onCommit={(v) => set(id, { fs: v })} />
              </dd>
              <dt title="Text colour, and an optional box colour behind it (a CSS colour like #ffd400 or white)">Colour</dt>
              <dd className="row">
                <Field value={clip.color} placeholder="white" onCommit={(v) => set(id, { color: v })} />
                box <Field value={clip.box} placeholder="—" onCommit={(v) => set(id, { box: v })} />
              </dd>
              <dt title="Pop in with a quick scale-up when it appears">Pop</dt>
              <dd>
                <input type="checkbox" title="Pop in with a quick scale-up" checked={!!clip.pop} onChange={(e) => set(id, { pop: e.target.checked || null })} />
              </dd>
              <dt title="Seconds of fade at the start (in) and end (out)">Fades</dt>
              <dd className="row">
                in <Field value={clip.fade?.[0]} placeholder="0" onCommit={(v) => studio.run((e) => setFades(e, [id], Number(v ?? 0)))} />
                out <Field value={clip.fade?.[1]} placeholder="0" onCommit={(v) => studio.run((e) => setFades(e, [id], undefined, Number(v ?? 0)))} /> s
              </dd>
            </>
          )}
          {clip.type === 'comp' && <CompFields clip={clip} />}
        </dl>
        <h4 title="Every field of the clip as JSON, for anything the form above doesn't show">Fields (JSON)</h4>
        <textarea className="fields" rows={Math.min(16, asJson.split('\n').length + 1)} value={json} onChange={(e) => setJson(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <div className="row">
          <button onClick={applyJson} disabled={json === asJson} title="Apply the JSON changes to the clip">Apply</button>
          <button className="ghost" onClick={() => setJson(asJson)} disabled={json === asJson} title="Undo your JSON changes">Reset</button>
        </div>
      </div>
    </aside>
  );
}

/** Set by the requests module (phase 4): comp-specific fields and versions. */
export let CompFields: (p: { clip: Extract<Clip, { type: 'comp' }> }) => JSX.Element | null = ({ clip }) => (
  <>
    <dt>Comp</dt>
    <dd className="small">{clip.comp}</dd>
  </>
);
export function setCompFields(c: typeof CompFields) {
  CompFields = c;
}

function MultiInspector({ ids }: { ids: string[] }) {
  return (
    <aside className="inspector panel">
      <div className="panel-head">
        <span>{ids.length} clips</span>
        <button className="ghost" onClick={() => studio.select(null)} title="Deselect (Esc)">✕</button>
      </div>
      <div className="panel-body">
        <div className="actions">
          <button onClick={() => studio.run((e) => deleteClips(e, ids), `deleted ${ids.length} clips`)} title="Delete these clips (Del)">Delete</button>
          <button onClick={() => studio.run((e) => rippleDeleteClips(e, ids), `ripple-deleted ${ids.length} clips`)} title="Delete and close the gaps (Shift+Del)">Ripple delete</button>
          <button onClick={() => duplicate(ids)} title="Duplicate these clips (Ctrl+D)">Duplicate</button>
        </div>
        <dl>
          <dt>Gain</dt>
          <dd>
            <Field value={undefined} placeholder="dB for all" onCommit={(v) => v !== null && studio.apply(setGain(ids, Number(v)), `gain of ${ids.length} clips`)} />
          </dd>
          <dt title="Seconds of fade at the start of every selected clip">Fade in</dt>
          <dd>
            <Field value={undefined} placeholder="s" onCommit={(v) => studio.run((e) => setFades(e, ids, v === null ? null : Number(v)), `fade in ${ids.length} clips`)} />
          </dd>
          <dt title="Seconds of fade at the end of every selected clip">Fade out</dt>
          <dd>
            <Field value={undefined} placeholder="s" onCommit={(v) => studio.run((e) => setFades(e, ids, undefined, v === null ? null : Number(v)), `fade out ${ids.length} clips`)} />
          </dd>
        </dl>
        <ul className="small">
          {ids.map((id) => (
            <li key={id}>
              <button className="link" onClick={() => studio.select(id)} title="Select only this clip">{id}</button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** Zoom keys of a video clip: [time from the clip's start, zoom, focus x, focus y] (source pixels). */
function ZoomKeys({ clip, player }: { clip: MediaClip; player: Player | null }) {
  const s = useStudio();
  const rc = s.resolved()?.clips.get(clip.id);
  const m = s.opened?.media[clip.src];
  const p = s.editor!.project;
  const region: [number, number, number, number] = Array.isArray(clip.region) ? clip.region : typeof clip.region === 'string' && p.regions[clip.region] ? p.regions[clip.region]! : [0, 0, m?.width ?? p.width, m?.height ?? p.height];
  const keys = clip.keys ?? [];
  const resolvedKeys = rc?.keys ?? [];
  const write = (next: typeof keys, label: string) => studio.apply([{ op: 'update_clip', id: clip.id, set: { keys: next.length ? next : null } }], label);
  const addAtPlayhead = () => {
    const local = Math.max(0, Math.round(((player?.time() ?? 0) - (rc?.start ?? 0)) * 1e3) / 1e3);
    const [z, fx, fy] = resolvedKeys.length ? keyed(resolvedKeys, local) : [1, region[2] / 2, region[3] / 2];
    const next = [...keys, [local, round(z, 3), Math.round(fx), Math.round(fy)] as (typeof keys)[number]];
    next.sort((a, b) => (typeof a[0] === 'number' && typeof b[0] === 'number' ? a[0] - b[0] : 0));
    write(next, `zoom key at ${local.toFixed(2)} s on ${clip.id}`);
  };
  return (
    <div className="keys">
      {keys.map((k, i) => (
        <div key={i} className="row small">
          <Field value={k[0]} title="Time: seconds from the clip's start (or start / dur terms)" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [v, x[1], x[2], x[3]] : x)), `zoom key ${i + 1} of ${clip.id}`)} />
          <Field value={k[1]} title="Zoom: 1 shows the whole picture, 2 is twice as close" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [x[0], Number(v), x[2], x[3]] : x)), `zoom key ${i + 1} of ${clip.id}`)} />
          <Field value={k[2]} title="Focus x: the point to centre on, in source pixels from the left of the crop" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [x[0], x[1], Number(v), x[3]] : x)), `zoom key ${i + 1} of ${clip.id}`)} />
          <Field value={k[3]} title="Focus y: in source pixels from the top of the crop" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [x[0], x[1], x[2], Number(v)] : x)), `zoom key ${i + 1} of ${clip.id}`)} />
          <button className="link" onClick={() => player?.seek((rc?.start ?? 0) + (resolvedKeys[i]?.[0] ?? 0))} title="Go to this key">⏵</button>
          <button className="link" onClick={() => write(keys.filter((_, j) => j !== i), `removed zoom key ${i + 1} of ${clip.id}`)} title="Remove this key">✕</button>
        </div>
      ))}
      {keys.length > 0 && <div className="muted small">time · zoom · focus x · focus y</div>}
      <button className="small" onClick={addAtPlayhead} title="Add a key at the playhead with the zoom it has there now; then change its values">
        + key at playhead
      </button>
    </div>
  );
}

/** Volume keys of an audio clip: [seconds from the clip's start, dB], on top of its gain. */
function GainKeys({ clip, player }: { clip: MediaClip; player: Player | null }) {
  const s = useStudio();
  const rc = s.resolved()?.clips.get(clip.id);
  const keys = clip.gainKeys ?? [];
  const write = (next: [number, number][], label: string) =>
    studio.apply([{ op: 'update_clip', id: clip.id, set: { gainKeys: next.length ? [...next].sort((a, b) => a[0] - b[0]) : null } }], label);
  const addAtPlayhead = () => {
    const local = Math.max(0, Math.round(((player?.time() ?? 0) - (rc?.start ?? 0)) * 1e3) / 1e3);
    write([...keys, [local, round(gainKeyAt(keys, local), 1)]], `volume key at ${local.toFixed(2)} s on ${clip.id}`);
  };
  return (
    <div className="keys">
      {keys.map((k, i) => (
        <div key={i} className="row small">
          <Field value={k[0]} title="Seconds from the clip's start" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [Number(v), x[1]] : x)), `volume key ${i + 1} of ${clip.id}`)} />
          <Field value={k[1]} title="Level in dB (0 = as is, -6 about half as loud, -40 nearly silent)" onCommit={(v) => v !== null && write(keys.map((x, j) => (j === i ? [x[0], Number(v)] : x)), `volume key ${i + 1} of ${clip.id}`)} /> dB
          <button className="link" onClick={() => player?.seek((rc?.start ?? 0) + k[0])} title="Go to this key">⏵</button>
          <button className="link" onClick={() => write(keys.filter((_, j) => j !== i), `removed volume key ${i + 1} of ${clip.id}`)} title="Remove this key">✕</button>
        </div>
      ))}
      <button className="small" onClick={addAtPlayhead} title="Add a key at the playhead with the level it has there now; then change it (e.g. -30 to fade the music down)">
        + key at playhead
      </button>
    </div>
  );
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Copies of clips right after the last one, on the same tracks (times become plain numbers). */
export function duplicate(ids: string[]) {
  const ed = studio.editor;
  const r = studio.resolved();
  if (!ed || !r) return;
  const spans = ids.map((id) => ({ id, rc: r.clips.get(id), c: ed.clip(id), t: ed.trackOf(id) })).filter((x) => x.rc && x.rc.end !== null && x.c && x.t);
  if (!spans.length) return;
  const b = Math.max(...spans.map((x) => x.rc!.end!));
  paste(spans.map((x) => ({ clip: x.c!, track: x.t!.id, start: x.rc!.start, end: x.rc!.end! })), b);
}

/** Clipboard entries: clips with their resolved times. Pasted so the earliest starts at `at`. */
export interface ClipCopy {
  clip: Clip;
  track: string;
  start: number;
  end: number;
  /** Where it was copied from, so a paste into another project can find its files and a matching track. */
  dir?: string;
  kind?: Track['kind'];
  /** The media file's full path (src may be relative to the project it came from). */
  abs?: string;
}

const CLIPBOARD = 'mangoai.clipboard';

/** Copy clips: kept in this tab and in the browser, so you can paste them into another project. */
export function copyClips(ids: string[]): ClipCopy[] {
  const r = studio.resolved();
  const ed = studio.editor;
  const o = studio.opened;
  if (!r || !ed || !o) return [];
  const items = ids
    .map((id) => ({ c: ed.clip(id), tr: ed.trackOf(id), rc: r.clips.get(id) }))
    .filter((x) => x.c && x.tr && x.rc && x.rc.end !== null)
    .map((x): ClipCopy => {
      const c = x.c!;
      const abs = c.type === 'media' ? o.media[c.src]?.path : c.type === 'comp' ? `${o.dir}/${c.comp}` : undefined;
      return { clip: structuredClone(c), track: x.tr!.id, kind: x.tr!.kind, start: x.rc!.start, end: x.rc!.end!, dir: o.dir, ...(abs && { abs }) };
    });
  try {
    localStorage.setItem(CLIPBOARD, JSON.stringify(items));
  } catch {}
  return items;
}

export function storedClips(): ClipCopy[] {
  try {
    return JSON.parse(localStorage.getItem(CLIPBOARD) ?? '[]') as ClipCopy[];
  } catch {
    return [];
  }
}

export function paste(items: ClipCopy[], at: number) {
  const ed = studio.editor;
  if (!ed || !items.length) return;
  const first = Math.min(...items.map((x) => x.start));
  const taken = new Set<string>();
  const ops: Op[] = [];
  const ids: string[] = [];
  const here = studio.opened?.dir;
  for (const it of items) {
    // another project: the same track id if it fits, else the first track of the same kind
    const fits = (tid: string) => {
      const tr = ed.track(tid);
      return !!tr && (!it.kind || tr.kind === it.kind);
    };
    const track = fits(it.track) ? it.track : ed.project.tracks.find((t) => t.kind === it.kind)?.id;
    if (!track) continue;
    it.track = track;
    const id = ed.freshId(`${it.clip.id.replace(/(\.copy|\.split)\d+$/, '')}.copy`, taken);
    taken.add(id);
    ids.push(id);
    const c = structuredClone(it.clip) as Clip & Record<string, unknown>;
    c.id = id;
    delete c.origin;
    if (it.dir && here && it.dir !== here && it.abs) {
      // files are named relative to the project they came from: use their full path here
      if (c.type === 'media') c.src = it.abs.replace(/\\/g, '/');
      if (c.type === 'comp') c.comp = it.abs.replace(/\\/g, '/');
    }
    const dt = at - first;
    c.start = Math.round((it.start + dt + (c.pivot ?? 0)) * 1e4) / 1e4;
    c.end = Math.round((it.end + dt) * 1e4) / 1e4;
    if (c.type === 'media' && c.speedTo) {
      const rc = studio.resolved()?.clips.get(it.clip.id);
      delete c.speedTo;
      c.in = rc?.in ?? 0;
      c.speed = rc?.speed ?? 1;
    }
    ops.push({ op: 'add_clip', track: it.track, clip: c });
  }
  if (studio.apply(ops, `pasted ${ops.length} clip${ops.length > 1 ? 's' : ''}`)) studio.setSelected(ids);
}

function ProjectInspector({ player }: { player: Player | null }) {
  const s = useStudio();
  const r = s.resolved()!;
  const p = s.editor!.project;
  const fps = p.fps;
  return (
    <aside className="inspector panel">
      <div className="panel-head">Project</div>
      <div className="panel-body">
        <dl>
          <dt>Title</dt>
          <dd>
            <Field value={p.title} onCommit={(v) => studio.apply([{ op: 'set_title', title: v === null ? null : String(v) }])} />
          </dd>
          <dt>Format</dt>
          <dd>
            {p.width}×{p.height} · {p.fps} fps
          </dd>
          <dt>Length</dt>
          <dd>{timecode(r.end, fps)}</dd>
          <dt title="How many times the project has been saved">Revision</dt>
          <dd>
            {p.revision} {s.dirty && <span className="dirty">· unsaved changes</span>}
          </dd>
          <dt>Clips</dt>
          <dd>
            {p.tracks.reduce((n, t) => n + t.clips.length, 0)} on {p.tracks.length} tracks
          </dd>
        </dl>
        <h4>Tracks</h4>
        <table className="tracks">
          <tbody>
            {p.tracks
              .slice()
              .reverse()
              .map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td className="muted small">{t.kind === 'audio' ? t.role ?? 'audio' : t.kind}</td>
                  <td>
                    {t.kind === 'audio' && (
                      <>
                        <Field value={t.gain} placeholder="0" title="Volume of the whole track in dB" onCommit={(v) => studio.apply([{ op: 'update_track', id: t.id, set: { gain: v === null ? null : Number(v) } }], `gain of track ${t.id}`)} /> dB
                      </>
                    )}
                    {t.kind === 'captions' && (
                      <label className="small">
                        <input type="checkbox" title="Show the captions in the preview and export" checked={t.enabled !== false} onChange={(e) => studio.apply([{ op: 'update_track', id: t.id, set: { enabled: e.target.checked ? null : false } }], `captions ${e.target.checked ? 'on' : 'off'}`)} /> on
                      </label>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <h4>Sections</h4>
        <ul className="sections">
          {r.sections.map((sec) => (
            <li key={sec.id}>
              <button className="ghost" onClick={() => player?.seek(sec.t0)} title="Go to this section">
                <span className="tc small">{timecode(sec.t0, fps)}</span> {sec.id}
              </button>
              <div className="muted small">{p.sections.find((x) => x.id === sec.id)?.note}</div>
            </li>
          ))}
        </ul>
        <h4>
          Markers <span className="muted small">(M adds one at the playhead)</span>
        </h4>
        <ul className="sections">
          {p.anchors.map((a) => (
            <li key={a.name} className="row">
              <button className="ghost" onClick={() => player?.seek(r.anchors.get(a.name) ?? 0)} title="Go to this marker">
                <span className="tc small">{timecode(r.anchors.get(a.name) ?? 0, fps)}</span> {a.name}
              </button>
              <Field value={a.at} title="Marker time: seconds or an expression" onCommit={(v) => v !== null && studio.apply([{ op: 'set_anchor', name: a.name, at: v }], `moved marker ${a.name}`)} />
              <button className="ghost" title="Remove" onClick={() => studio.apply([{ op: 'set_anchor', name: a.name, at: null }], `removed marker ${a.name}`)}>✕</button>
            </li>
          ))}
        </ul>
        {r.problems.length > 0 && (
          <>
            <h4>Problems</h4>
            <ul className="problems">
              {r.problems.map((pr) => (
                <li key={pr.path}>{pr.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
