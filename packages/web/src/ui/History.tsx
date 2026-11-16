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
                  <button className="link small" onClick={() => void restore(l.rev)}>
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
