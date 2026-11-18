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
      <Meter player={player} />
    </div>
  );
}

/** Level meter: RMS (about the loudness) and peak of what's playing, in dB. */
function Meter({ player }: { player: Player }) {
  const { rms, peak } = player.levels();
  const pos = (db: number) => `${Math.max(0, Math.min(100, ((db + 48) / 48) * 100))}%`;
  const hot = peak > -1;
  return (
    <span
      className={`meter ${hot ? 'hot' : ''}`}
      title={`Level while playing: ${Number.isFinite(rms) ? `${rms.toFixed(1)} dB RMS (about the loudness)` : 'silent'}, peak ${Number.isFinite(peak) ? `${peak.toFixed(1)} dB` : '-'}.
The export levels the whole mix to the target in the Export tab; red means a peak near 0 dB (the limiter catches it).`}
    >
      <span className="bar">
        <span className="fill" style={{ width: pos(rms) }} />
        <span className="peak" style={{ left: pos(peak) }} />
        <span className="mark" style={{ left: pos(-14) }} />
      </span>
      <span className="small">{Number.isFinite(rms) ? rms.toFixed(0) : '–'} dB</span>
    </span>
  );
}
