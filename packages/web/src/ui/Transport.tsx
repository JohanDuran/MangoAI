import { useEffect, useState } from 'react';
import type { Player } from '../engine/player';

export function timecode(t: number, fps = 30) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps + 1e-6);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function Transport({ player }: { player: Player }) {
  const [, tick] = useState(0);
  useEffect(() => player.onChange(() => tick((n) => n + 1)), [player]);
  const fps = player.project.fps;
  return (
    <div className="transport">
      <button onClick={() => player.seek(0)} title="Start (Home)">⏮</button>
      <button onClick={() => player.seek(player.time() - 1 / fps)} title="Back one frame (←)">◀︎</button>
      <button className="play" onClick={() => player.toggle()} title="Play / pause (Space)">
        {player.isPlaying ? '⏸' : '▶'}
      </button>
      <button onClick={() => player.seek(player.time() + 1 / fps)} title="Forward one frame (→)">▶︎</button>
      <button onClick={() => player.seek(player.duration)} title="End (End)">⏭</button>
      <span className="tc">{timecode(player.time(), fps)}</span>
      <span className="muted">/ {timecode(player.duration, fps)}</span>
      {player.isPlaying && <span className="muted small" title="Worst video drift from the audio clock this frame">sync {(player.lastDrift * 1000).toFixed(0)} ms</span>}
    </div>
  );
}
