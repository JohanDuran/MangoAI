// Revisions: every Save (yours or Claude's) is one line in .mangoai/history.jsonl. Any revision can be
// brought back (as a new revision, so nothing is lost).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { studio, useStudio } from '../store';

interface Line {
  rev: number;
  author: 'you' | 'claude';
  at: string;
  label: string;
  summary: string[];
}

/** The undo history as a list: done steps, then undone ones (greyed) that redo would bring back. */
function Steps() {
  const s = useStudio();
  const e = s.editor;
  if (!e) return null;
  const done = e.history;
  const future = e.future;
  if (!done.length && !future.length) return <div className="muted small">No edits yet in this session.</div>;
  return (
    <ul className="history steps">
      <li className={done.length === 0 ? 'here' : ''}>
        <button className="link small" onClick={() => studio.jumpTo(0)} title="Go back to before the first edit">
          (opened)
        </button>
      </li>
      {done.map((c, i) => (
        <li key={`d${i}`} className={i === done.length - 1 ? 'here' : ''}>
          <button className="link small" onClick={() => studio.jumpTo(i + 1)} title={c.summary.join('\n')}>
            <span className={`who ${c.author}`}>{c.author === 'claude' ? 'Claude' : 'you'}</span> {c.label}
          </button>
        </li>
      ))}
      {future.map((c, i) => (
        <li key={`f${i}`} className="undone">
          <button className="link small" onClick={() => studio.jumpTo(done.length + i + 1)} title={`Undone. Click to redo up to here.\n${c.summary.join('\n')}`}>
            <span className={`who ${c.author}`}>{c.author === 'claude' ? 'Claude' : 'you'}</span> {c.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function History() {
  const s = useStudio();
  const [lines, setLines] = useState<Line[]>([]);
  const rev = s.editor?.project.revision ?? 0;
  const dir = s.opened?.dir ?? '';
  useEffect(() => {
    if (dir) api.get<{ lines: Line[] }>(`/api/history?${new URLSearchParams({ dir })}`).then((r) => setLines(r.lines), () => setLines([]));
  }, [dir, rev]);
  const unsaved = s.editor?.unsaved() ?? [];
  const restore = async (r: number) => {
    if (studio.dirty && !confirm('You have unsaved edits. Restoring makes a new revision from the old one and drops them. Continue?')) return;
    try {
      await api.post('/api/restore', { dir, rev: r });
      await studio.open(dir, true);
      studio.flash(`Restored revision ${r} as a new revision`);
    } catch (e) {
      studio.flash((e as Error).message, true);
    }
  };
  return (
    <div className="panel side-body">
      <div className="panel-body">
        <h4 title="Every edit since the project opened; click one to go back (or forward) to right after it">Edit steps</h4>
        <Steps />
        <h4>Not saved yet ({unsaved.length})</h4>
        {unsaved.length === 0 ? (
          <div className="muted small">Nothing. Edits you make stay here until you Save.</div>
        ) : (
          <ul className="history">
            {unsaved.map((c, i) => (
              <li key={i}>
                <span className="who you">you</span> {c.summary.join('; ')}
              </li>
            ))}
          </ul>
        )}
        <h4>Saved revisions</h4>
        {lines.length === 0 && <div className="muted small">No saves yet.</div>}
        <ul className="history">
          {[...lines].reverse().map((l) => (
            <li key={l.rev}>
              <div className="row">
                <b>rev {l.rev}</b>
                <span className={`who ${l.author}`}>{l.author === 'claude' ? 'Claude' : 'you'}</span>
                <span className="muted small">{new Date(l.at).toLocaleString()}</span>
                <span className="spacer" />
                {l.rev !== rev && (
                  <button className="link small" onClick={() => void restore(l.rev)} title="Go back to this revision (saved as a new revision, nothing is lost)">
                    restore
                  </button>
                )}
              </div>
              <div className="small">{l.summary.slice(0, 6).join('; ')}{l.summary.length > 6 ? ` … (+${l.summary.length - 6})` : ''}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
