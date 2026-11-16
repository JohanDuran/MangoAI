import { useEffect, useMemo, useState } from 'react';
import { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { Inspector } from './Inspector';
import { MediaPool } from './MediaPool';
import { OpenDialog } from './OpenDialog';
import { Timeline } from './Timeline';
import { Transport } from './Transport';
import { Viewer } from './Viewer';

export function App() {
  const s = useStudio();
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    const dir = new URLSearchParams(location.search).get('dir');
    if (dir) void studio.open(dir);
  }, []);

  const opened = s.opened;
  const player = useMemo(() => {
    if (!opened || !s.editor) return null;
    return new Player(opened, () => studio.resolved()!, opened.words, (src) => studio.peaks.get(src)?.lufs ?? null);
    // a new player per opened project
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);
  useEffect(() => () => player?.dispose(), [player]);
  useEffect(() => {
    // debugging/inspection handle (devtools, automated checks)
    (window as unknown as { __mango: unknown }).__mango = { player, studio };
  }, [player]);
  useEffect(() => {
    // levels arrive with the peaks; restart audio so the voice uses them
    player?.rebuild();
  }, [player, s.peaks.size]);

  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const fps = s.opened?.project.fps ?? 30;
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / fps;
        player.seek(player.time() + (e.key === 'ArrowLeft' ? -step : step));
      } else if (e.key === 'Home') player.seek(0);
      else if (e.key === 'End') player.seek(player.duration);
      else if (e.key === 'Escape') studio.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, s.opened]);

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

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">🥭 MangoAI</span>
        <button className="ghost" onClick={() => setBrowsing(true)} title="Open another project">
          {opened.name}
        </button>
        <span className="muted">
          {opened.project.title} · opened from {opened.from}
          {opened.from === 'short.json' && ' (read-only preview, nothing is written)'}
        </span>
        {s.error && <span className="error-text">{s.error}</span>}
      </header>
      <main className="workspace">
        <MediaPool />
        <section className="center">
          {player && <Viewer player={player} />}
          {player && <Transport player={player} />}
        </section>
        <Inspector player={player} />
      </main>
      {player && <Timeline player={player} />}
    </div>
  );
}
