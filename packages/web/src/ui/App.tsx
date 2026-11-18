import { moveClips, rippleDelete, rippleDeleteClips, deleteClips, splitAt } from '@mangoai/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { ExportPanel } from './Export';
import { History } from './History';
import { duplicate, Inspector, paste, type ClipCopy } from './Inspector';
import { MediaPool } from './MediaPool';
import { OpenDialog } from './OpenDialog';
import { Requests } from './Requests';
import { ToolboxPanel } from './Toolbox';
import { Timeline } from './Timeline';
import { Transcript } from './Transcript';
import { Transport } from './Transport';
import { Viewer } from './Viewer';

type Tab = 'inspect' | 'requests' | 'transcript' | 'history' | 'toolbox' | 'export';

export function App() {
  const s = useStudio();
  const [browsing, setBrowsing] = useState(false);
  const [tab, setTab] = useState<Tab>('inspect');
  const clipboard = useRef<ClipCopy[]>([]);

  useEffect(() => {
    const dir = new URLSearchParams(location.search).get('dir');
    if (dir) void studio.open(dir);
  }, []);

  const opened = s.opened;
  const player = useMemo(() => {
    if (!opened || !s.editor) return null;
    return new Player(opened, () => studio.resolved()!, () => studio.resolved()?.words ?? null, (src) => studio.peaks.get(src)?.lufs ?? null);
    // a new player per opened project
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  useEffect(() => () => player?.dispose(), [player]);
  useEffect(() => {
    // debugging/inspection handle (devtools, automated checks)
    (window as unknown as { __mango: unknown }).__mango = { player, studio };
    if (!player) return;
    studio.playhead = () => player.time();
    // Claude's `frame` tool: draw that frame here and post it back
    studio.frameHandler = async (t, id) => {
      const dir = studio.opened!.dir;
      const comps = player.compsAt(t);
      const post = (blob: Blob, layer: string) =>
        fetch(`/api/snapshot?${new URLSearchParams({ dir, name: `frame-${id}`, req: id, layer, comps: JSON.stringify(comps.map((c) => ({ comp: c.comp, local: c.local }))) })}`, { method: 'POST', body: blob });
      if (!comps.length) return void (await post(await player.snapshot(t), 'all'));
      // comps are iframes: send the layers under and over them; the server adds each comp's still between
      await post(await player.snapshot(t, null, 'base'), 'base');
      await post(await player.snapshot(t, null, 'top'), 'top');
    };
    return studio.onEdit(() => player.rebuild());
  }, [player]);
  useEffect(() => {
    // levels arrive with the peaks; restart audio so the voice uses them
    player?.rebuild();
  }, [player, s.peaks.size]);

  // leaving with unsaved edits: the draft keeps them, but say so
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (studio.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      const fps = studio.editor?.project.fps ?? 30;
      const ctrl = e.ctrlKey || e.metaKey;
      const sel = studio.selected;
      const t = player.time();
      const key = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      } else if (ctrl && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) studio.redo();
        else studio.undo();
      } else if (ctrl && key === 'y') {
        e.preventDefault();
        studio.redo();
      } else if (ctrl && key === 's') {
        e.preventDefault();
        void studio.save();
      } else if (ctrl && key === 'c') {
        const r = studio.resolved();
        clipboard.current = sel
          .map((id) => ({ c: studio.editor?.clip(id), tr: studio.editor?.trackOf(id), rc: r?.clips.get(id) }))
          .filter((x) => x.c && x.tr && x.rc && x.rc.end !== null)
          .map((x) => ({ clip: structuredClone(x.c!), track: x.tr!.id, start: x.rc!.start, end: x.rc!.end! }));
        if (clipboard.current.length) studio.flash(`Copied ${clipboard.current.length} clip(s)`);
      } else if (ctrl && key === 'v') {
        paste(clipboard.current, t);
      } else if (ctrl && key === 'd') {
        e.preventDefault();
        duplicate(sel);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (e.shiftKey) {
          if (sel.length) studio.run((ed) => rippleDeleteClips(ed, sel), `ripple-deleted ${sel.length} clip(s)`);
          else if (studio.range) {
            const [a, b] = studio.range;
            if (studio.run((ed) => rippleDelete(ed, a, b, null), `cut ${(b - a).toFixed(2)} s out at ${a.toFixed(2)} s`)) studio.setRange(null);
          }
        } else if (sel.length) studio.run((ed) => deleteClips(ed, sel), `deleted ${sel.length} clip(s)`);
      } else if (!ctrl && key === 's') {
        const ids = sel.filter((id) => {
          const rc = studio.resolved()?.clips.get(id);
          return rc && rc.end !== null && t > rc.start && t < rc.end;
        });
        studio.run((ed) => splitAt(ed, t, ids), ids.length ? `split ${ids.join(', ')}` : `split everything at ${t.toFixed(2)} s`);
      } else if (ctrl && key === 'b') {
        e.preventDefault();
        studio.run((ed) => splitAt(ed, t, sel), `split at ${t.toFixed(2)} s`);
      } else if ((e.key === ',' || e.key === '.') && sel.length) {
        const d = ((e.shiftKey ? 10 : 1) / fps) * (e.key === ',' ? -1 : 1);
        studio.run((ed) => moveClips(ed, sel, d), `nudged ${sel.length} clip(s) ${d > 0 ? 'later' : 'earlier'}`);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / fps;
        player.seek(t + (e.key === 'ArrowLeft' ? -step : step));
      } else if (e.key === 'Home') player.seek(0);
      else if (e.key === 'End') player.seek(player.duration);
      else if (key === 'i') studio.setRange([t, Math.max(t + 0.5, studio.range?.[1] ?? t + 2)]);
      else if (key === 'o') studio.setRange([Math.min(studio.range?.[0] ?? t - 2, t - 0.1), t]);
      else if (key === 'x' && !ctrl) studio.setRange(null);
      else if (key === 'm' && !ctrl) {
        const ed = studio.editor!;
        let n = 1;
        while (ed.project.anchors.some((a) => a.name === `m${n}`) || ed.project.sections.some((x) => x.id === `m${n}`)) n++;
        studio.apply([{ op: 'set_anchor', name: `m${n}`, at: Math.round(t * 1e4) / 1e4 }], `added marker m${n}`);
      } else if (key === 'r' && !ctrl) {
        studio.setMode(studio.mode === 'request' ? 'edit' : 'request');
        setTab('requests');
      } else if (e.key === 'Escape') {
        studio.select(null);
        studio.setPicked(null);
        studio.setRegion(null);
        if (studio.mode === 'request') studio.setMode('edit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  if (!opened || browsing) {
    return (
      <div className="app empty">
        <OpenDialog
          onOpen={(dir) => {
            setBrowsing(false);
            history.replaceState(null, '', `?dir=${encodeURIComponent(dir)}`);
            void studio.open(dir);
          }}
          onCancel={opened ? () => setBrowsing(false) : undefined}
        />
        {s.loading && <div className="toast">Opening…</div>}
        {s.error && <div className="toast error">{s.error}</div>}
      </div>
    );
  }

  const ed = s.editor;
  const open = (s.editor?.project.requests ?? []).filter((r) => r.status === 'open' || r.status === 'working').length;
  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">🥭 MangoAI</span>
        <button className="ghost" onClick={() => setBrowsing(true)} title="Open another project">
          {opened.name}
        </button>
        <span className="muted small">
          <span title="Saved revision of cut.json; each Save (yours or Claude's) adds one">rev {ed?.project.revision ?? 0}</span>
          {opened.from === 'short.json' && ' · imported from short.json (Save writes cut.json next to it)'}
        </span>
        <span className="spacer" />
        <button onClick={() => studio.undo()} disabled={!ed?.canUndo} title="Undo (Ctrl+Z)">↶</button>
        <button onClick={() => studio.redo()} disabled={!ed?.canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button
          className={s.mode === 'request' ? 'on' : ''}
          onClick={() => {
            studio.setMode(s.mode === 'request' ? 'edit' : 'request');
            setTab('requests');
          }}
          title="Point at something in the viewer, or draw a box, and leave Claude a request (R)"
        >
          ✎ Request
        </button>
        <button className={`save ${s.dirty ? 'dirty' : ''}`} onClick={() => void studio.save()} disabled={s.saving || (!s.dirty && opened.from === 'cut.json')} title="Save (Ctrl+S): writes cut.json as a new revision Claude will see">
          {s.saving ? 'Saving…' : s.dirty ? '● Save' : 'Saved'}
        </button>
      </header>
      {s.draftOffer > 0 && (
        <div className="banner">
          This project has {s.draftOffer} unsaved edit{s.draftOffer > 1 ? 's' : ''} from a tab that closed.
          <button onClick={() => studio.restoreDraft()} title="Bring back the edits that weren't saved">Restore</button>
          <button className="ghost" onClick={() => studio.discardDraft()} title="Throw those edits away and keep the saved version">Discard</button>
        </div>
      )}
      <main className="workspace">
        <MediaPool />
        <section className="center">
          {player && <Viewer player={player} />}
          {player && <Transport player={player} />}
        </section>
        <aside className="side">
          <nav className="tabs">
            {(
              [
                ['inspect', 'Inspector', 'The selected clip, or the project when nothing is selected'],
                ['requests', `Requests${open ? ` (${open})` : ''}`, 'Things you asked Claude to change or make, and their status'],
                ['transcript', 'Transcript', 'The voice track as words: click to jump, select to cut, find pauses and fillers'],
                ['history', 'History', 'Every saved revision, by you or Claude; restore any of them'],
                ['toolbox', 'Toolbox', 'Sounds and voice lines from the media toolbox'],
                ['export', 'Export', 'Render the video (only the parts that changed)'],
              ] as [Tab, string, string][]
            ).map(([k, label, help]) => (
              <button key={k} className={tab === k ? 'on' : 'ghost'} onClick={() => setTab(k)} title={help}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'inspect' && <Inspector player={player} />}
          {tab === 'requests' && <Requests player={player} />}
          {tab === 'transcript' && <Transcript player={player} />}
          {tab === 'history' && <History />}
          {tab === 'toolbox' && <ToolboxPanel player={player} />}
          {tab === 'export' && <ExportPanel player={player} />}
        </aside>
      </main>
      {player && <Timeline player={player} />}
      {(s.error || s.notice) && <div className={`toast ${s.error ? 'error' : ''}`}>{s.error ?? s.notice}</div>}
    </div>
  );
}

