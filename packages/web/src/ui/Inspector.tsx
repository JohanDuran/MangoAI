import type { Player } from '../engine/player';
import { studio, useStudio } from '../store';
import { timecode } from './Transport';

/** Read-only in phase 1: what the selected clip is, where it came from, and its resolved times. */
export function Inspector({ player }: { player: Player | null }) {
  const s = useStudio();
  const r = s.resolved();
  const sel = s.selection ? s.clip(s.selection) : null;
  const fps = s.opened?.project.fps ?? 30;

  if (!sel || !r) {
    const p = s.opened?.project;
    return (
      <aside className="inspector panel">
        <div className="panel-head">Project</div>
        <div className="panel-body">
          {p && (
            <>
              <dl>
                <dt>Format</dt>
                <dd>{p.width}×{p.height} · {p.fps} fps</dd>
                <dt>Length</dt>
                <dd>{timecode(r?.end ?? 0, fps)}</dd>
                <dt>Tracks</dt>
                <dd>{p.tracks.length} · {p.tracks.reduce((n, t) => n + t.clips.length, 0)} clips</dd>
              </dl>
              <h4>Sections</h4>
              <ul className="sections">
                {r?.sections.map((sec) => (
                  <li key={sec.id}>
                    <button className="ghost" onClick={() => player?.seek(sec.t0)}>
                      <span className="tc small">{timecode(sec.t0, fps)}</span> {sec.id}
                    </button>
                    <div className="muted small">{p.sections.find((x) => x.id === sec.id)?.note}</div>
                  </li>
                ))}
              </ul>
              {r && r.problems.length > 0 && (
                <>
                  <h4>Problems</h4>
                  <ul className="problems">
                    {r.problems.map((pr) => (
                      <li key={pr.path}>{pr.message}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    );
  }

  const rc = r.clips.get(sel.clip.id);
  const { id, type, ...fields } = sel.clip;
  return (
    <aside className="inspector panel">
      <div className="panel-head">
        <span>
          {type} · {id}
        </span>
        <button className="ghost" onClick={() => studio.select(null)}>✕</button>
      </div>
      <div className="panel-body">
        <dl>
          <dt>Track</dt>
          <dd>{sel.track.id} {sel.track.name ? `· ${sel.track.name}` : ''}</dd>
          <dt>Starts</dt>
          <dd>
            <button className="ghost tc" onClick={() => rc && player?.seek(rc.start)}>{rc ? timecode(rc.start, fps) : '—'}</button>
          </dd>
          <dt>Ends</dt>
          <dd className="tc">{rc?.end != null ? timecode(rc.end, fps) : 'end of media'}</dd>
          {rc?.in !== undefined && (
            <>
              <dt>Source in</dt>
              <dd className="tc">{rc.in.toFixed(3)} s{rc.speed !== 1 ? ` · ×${rc.speed?.toFixed(2)}` : ''}</dd>
            </>
          )}
        </dl>
        <h4>Fields</h4>
        <pre className="fields">{JSON.stringify(fields, null, 1)}</pre>
      </div>
    </aside>
  );
}
