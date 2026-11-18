// Requests: point at something (click a graphic, or draw a box over a time range) and say what you want.
// They're saved in cut.json with the rest of the edit, so Claude sees them after you Save. Claude answers
// in the chat and sets each one to working / done / rejected; comp edits keep versions you can flip between.
import type { CompClip, Request } from '@mangoai/core';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { setCompFields } from './Inspector';
import { timecode } from './Transport';

const STATUS: Record<Request['status'], string> = { open: '○ open', working: '◐ Claude is on it', done: '● done', rejected: '✕ not done' };

export function Requests({ player }: { player: Player | null }) {
  const s = useStudio();
  const [text, setText] = useState('');
  const [assets, setAssets] = useState<string[]>([]);
  const [compare, setCompare] = useState<Request | null>(null);
  const p = s.editor!.project;
  const fps = p.fps;
  const list = p.requests ?? [];
  const t = player?.time() ?? 0;
  const picked = s.picked;
  const kind: Request['kind'] = picked ? 'change' : 'create';
  const range = s.range ?? (s.region ? ([Math.round(t * 1e3) / 1e3, Math.round((t + 3) * 1e3) / 1e3] as [number, number]) : null);

  const add = async () => {
    const ed = studio.editor;
    if (!ed || !text.trim()) return;
    const id = ed.freshId('r');
    const req: Request = {
      id,
      kind,
      status: 'open',
      text: text.trim(),
      t: Math.round(t * 1e4) / 1e4,
      created: new Date().toISOString(),
      ...(picked && { clip: picked.clip }),
      ...(picked && (picked.selector || picked.box) && {
        element: { ...(picked.selector && { selector: picked.selector }), ...(picked.id && { id: picked.id }), ...(picked.text && { text: picked.text }), ...(picked.box && { box: picked.box }) },
      }),
      ...(!picked && range && { range }),
      ...(s.region && { region: s.region }),
      ...(assets.length && { assets }),
    };
    // a still of the frame with the target boxed, so Claude sees what you saw
    if (player) {
      try {
        const box = picked?.box ?? (s.region ? [s.region[0] * p.width, s.region[1] * p.height, s.region[2] * p.width, s.region[3] * p.height] : null);
        const blob = await player.snapshot(t, box as [number, number, number, number] | null);
        const res = await fetch(`/api/snapshot?${new URLSearchParams({ dir: studio.opened!.dir, name: `request-${id}`, folder: 'requests' })}`, { method: 'POST', body: blob });
        const out = (await res.json()) as { rel?: string };
        if (out.rel) req.still = out.rel;
      } catch {}
    }
    if (studio.apply([{ op: 'add_request', request: req }], `request ${id}: ${req.text}`)) {
      setText('');
      setAssets([]);
      studio.setPicked(null);
      studio.setRegion(null);
      studio.flash('Request added. Save (Ctrl+S) and Claude will see it on your next message');
    }
  };

  return (
    <div className="panel side-body">
      <div className="panel-body">
        <div className={`compose ${s.mode === 'request' ? 'on' : ''}`}>
          <div className="row">
            <button className={s.mode === 'request' ? 'on' : ''} onClick={() => studio.setMode(s.mode === 'request' ? 'edit' : 'request')} title="Click a graphic in the viewer, or drag a box where something new should go (R)">
              {s.mode === 'request' ? 'Pointing… (Esc to stop)' : '✎ Point in the viewer'}
            </button>
          </div>
          <div className="target small">
            {picked ? (
              <>
                <b>Change</b> {picked.clip}
                {picked.selector && <> › <code>{picked.selector}</code></>}
                {picked.text && <div className="muted">“{picked.text.slice(0, 60)}”</div>}
              </>
            ) : s.region || s.range ? (
              <>
                <b>New</b> {range ? `${timecode(range[0], fps)} – ${timecode(range[1], fps)}` : ''}
                {s.region && <span className="muted"> · box {s.region.map((v) => v.toFixed(2)).join(', ')}</span>}
                {!s.range && <div className="muted">Set the time range with I / O or Shift-drag on the ruler (default: 3 s from the playhead)</div>}
              </>
            ) : (
              <span className="muted">Click a graphic in the viewer to change it, or draw a box (and set a range) for something new. Or just describe it.</span>
            )}
          </div>
          <textarea
            rows={3}
            placeholder={picked ? 'What should change? e.g. count up slower, make it yellow' : 'What should go here? e.g. animated diagram of the request going through 3 servers'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
            }}
          />
          <div
            className="assets small"
            onDragOver={(e) => e.dataTransfer.types.includes('text/mango-path') && e.preventDefault()}
            onDrop={(e) => {
              const path = e.dataTransfer.getData('text/mango-path');
              if (path) setAssets((a) => [...new Set([...a, studio.srcOf(path)])]);
            }}
          >
            {assets.length ? assets.map((a) => (
              <span key={a} className="chip">
                {a.split('/').pop()} <button className="link" onClick={() => setAssets((x) => x.filter((y) => y !== a))} title="Remove this file from the request">✕</button>
              </span>
            )) : <span className="muted">Drop files from the media pool here to use them (a logo, a screenshot)</span>}
          </div>
          <button className="primary" disabled={!text.trim()} onClick={() => void add()} title="Add the request (Ctrl+Enter); Save so Claude sees it">
            Add request
          </button>
        </div>

        <h4>Requests ({list.length})</h4>
        {list.length === 0 && <div className="muted small">None yet.</div>}
        <ul className="requests">
          {[...list].reverse().map((r) => (
            <li key={r.id} className={`req ${r.status}`}>
              <div className="row">
                <span className="small" title={r.status === 'open' ? 'Waiting for Claude' : r.status === 'working' ? 'Claude is working on it' : r.status === 'done' ? 'Claude finished it' : "Claude didn't do it; see the reply"}>{STATUS[r.status]}</span>
                <span className="spacer" />
                <button className="ghost tc small" onClick={() => player?.seek(r.range?.[0] ?? r.t ?? 0)} title="Go to this request">
                  {timecode(r.range?.[0] ?? r.t ?? 0, fps)}
                </button>
              </div>
              <div>{r.text}</div>
              <div className="muted small">
                {r.id} · {r.kind === 'change' ? `change ${r.clip ?? ''}${r.element?.selector ? ` › ${r.element.selector}` : ''}` : `new ${r.range ? `${(r.range[1] - r.range[0]).toFixed(1)} s` : ''}`}
                {r.assets?.length ? ` · ${r.assets.length} asset(s)` : ''}
              </div>
              <Thread r={r} />
              <div className="row small">
                {(r.status === 'done' || r.status === 'rejected') && r.still && player && (
                  <button className="link" onClick={() => setCompare(r)} title="See the frame as it was when you asked, next to how it looks now">
                    before / after
                  </button>
                )}
                {r.status !== 'open' && <button className="link" onClick={() => studio.apply([{ op: 'update_request', id: r.id, set: { status: 'open' } }], `reopened ${r.id}`)} title="Set it back to open so Claude looks at it again">reopen</button>}
                {r.status === 'open' && <button className="link" onClick={() => studio.apply([{ op: 'update_request', id: r.id, set: { status: 'done' } }], `closed ${r.id}`)} title="Close it yourself">mark done</button>}
                <button className="link" onClick={() => studio.apply([{ op: 'remove_request', id: r.id }], `removed ${r.id}`)} title="Delete this request">remove</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {compare && player && <Compare r={compare} player={player} onClose={() => setCompare(null)} />}
    </div>
  );
}

/** The conversation on a request: Claude's answers and your follow-ups, plus a box to write one. */
function Thread({ r }: { r: Request }) {
  const [text, setText] = useState('');
  // older requests only have `reply`; show it when there are no notes yet
  const notes = r.notes ?? (r.reply ? [{ by: 'claude' as const, text: r.reply, at: '' }] : []);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const next = [...(r.notes ?? (r.reply ? [{ by: 'claude' as const, text: r.reply, at: r.created }] : [])), { by: 'you' as const, text: t, at: new Date().toISOString() }];
    if (studio.apply([{ op: 'update_request', id: r.id, set: { notes: next, status: 'open' } }], `follow-up on ${r.id}: ${t.slice(0, 60)}`)) {
      setText('');
      studio.flash('Follow-up added. Save (Ctrl+S) and Claude will see it on your next message');
    }
  };
  return (
    <>
      {notes.map((n, i) => (
        <div key={i} className={`note small ${n.by}`}>
          <b>{n.by === 'claude' ? 'Claude' : 'You'}:</b> {n.text}
        </div>
      ))}
      {r.status !== 'working' && (
        <div className="row small follow">
          <input
            placeholder={r.status === 'open' ? 'Add a detail…' : 'Not quite? Say what to change…'}
            title="A follow-up on this request; it reopens the request for Claude (Enter to send)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') send();
            }}
          />
          <button className="small" disabled={!text.trim()} onClick={send} title="Send the follow-up (Enter)">
            Reply
          </button>
        </div>
      )}
    </>
  );
}

/** Before (the still taken when you asked) and after (the frame now), with a wipe between them. */
function Compare({ r, player, onClose }: { r: Request; player: Player; onClose: () => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const [wipe, setWipe] = useState(50);
  const p = player.project;
  const dir = studio.opened?.dir ?? '';
  const before = `/api/file?path=${encodeURIComponent(`${dir}/${r.still}`)}`;
  useEffect(() => {
    let url: string | null = null;
    const box = r.element?.box ?? (r.region ? [r.region[0] * p.width, r.region[1] * p.height, r.region[2] * p.width, r.region[3] * p.height] : null);
    void player.snapshot(r.t ?? r.range?.[0] ?? 0, box as [number, number, number, number] | null).then((b) => {
      url = URL.createObjectURL(b);
      setAfter(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [r.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="modal-body compare" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row">
          <b>{r.id}</b> <span className="muted small">{r.text}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="wipe" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
          {after ? <img src={after} alt="after" /> : <div className="muted small pad">Drawing the frame now…</div>}
          <img src={before} alt="before" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }} />
          <div className="wipe-line" style={{ left: `${wipe}%` }} />
          <span className="tag l">before</span>
          <span className="tag r">after</span>
        </div>
        <input type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} title="Drag to wipe between before (left) and after (right)" />
      </div>
    </div>
  );
}

interface Versions {
  versions: { v: number; at: string; note?: string }[];
  current: number | null;
}

/** Comp clip fields in the inspector: the scene folder and its versions (◀ v3 / v4 ▶). */
function CompFieldsWithVersions({ clip }: { clip: CompClip }) {
  const dir = studio.opened?.dir ?? '';
  const [ver, setVer] = useState<Versions | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Versions>(`/api/comp/versions?${new URLSearchParams({ dir, clip: clip.id, comp: clip.comp })}`).then(setVer, () => setVer(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.comp, studio.compVersion.get(clip.id)]);
  const go = async (action: 'switch' | 'snapshot', v?: number) => {
    setBusy(true);
    try {
      await api.post('/api/comp/versions', { dir, clip: clip.id, comp: clip.comp, action, v });
      await load();
    } catch (e) {
      studio.flash((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const list = ver?.versions ?? [];
  const cur = ver?.current ?? null;
  const i = cur === null ? list.length : list.findIndex((x) => x.v === cur);
  return (
    <>
      <dt title="The HyperFrames scene folder this clip renders">Comp</dt>
      <dd className="small" title={clip.comp}>{clip.comp}</dd>
      <dt title="Values passed into the scene">Vars</dt>
      <dd className="small">{clip.vars ? <code>{JSON.stringify(clip.vars)}</code> : <span className="muted">none</span>}</dd>
      <dt title="Saved copies of the scene; flip between them">Versions</dt>
      <dd className="row small">
        <button disabled={busy || i <= 0} onClick={() => void go('switch', list[i - 1]!.v)} title="Older version">◀</button>
        <span>{list.length === 0 ? 'only this one' : cur === null ? `current (after v${list[list.length - 1]!.v})` : `v${cur} of ${list.length}`}</span>
        <button disabled={busy || cur === null || i >= list.length - 1} onClick={() => void go('switch', list[i + 1]!.v)} title="Newer version">▶</button>
        <button className="ghost" disabled={busy} onClick={() => void go('snapshot')} title="Keep a copy of the comp as it is now">Keep a copy</button>
      </dd>
    </>
  );
}

setCompFields(CompFieldsWithVersions);
