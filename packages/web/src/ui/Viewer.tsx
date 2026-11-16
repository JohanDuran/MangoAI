import { useEffect, useRef } from 'react';
import type { Player } from '../engine/player';

export function Viewer({ player }: { player: Player }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    player.attach(ref.current);
    return () => player.attach(null);
  }, [player]);
  const p = player.project;
  return (
    <div className="viewer" onClick={() => player.toggle()}>
      <canvas ref={ref} width={p.width} height={p.height} style={{ aspectRatio: `${p.width} / ${p.height}` }} />
    </div>
  );
}
