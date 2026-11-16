import { useEffect, useState } from 'react';
import { api, type Browse } from '../api';
import { recent } from '../store';

export function OpenDialog({ onOpen, onCancel }: { onOpen: (dir: string) => void; onCancel?: (() => void) | undefined }) {
  const [b, setB] = useState<Browse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState('');

  const go = (dir?: string) =>
    api.browse(dir).then(
      (r) => {
        setB(r);
        setPath(r.dir);
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => void go(), []);

  const last = recent();
  return (
    <div className="open-dialog">
      <h1>🥭 MangoAI</h1>
      <p className="muted">Open a project folder (one with a cut.json or short.json).</p>
      <form
        className="path-row"
        onSubmit={(e) => {
          e.preventDefault();
          void go(path);
        }}
      >
        <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
        <button type="submit">Go</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </form>
      {err && <div className="error-text">{err}</div>}
      {last.length > 0 && (
        <>
          <h3>Recent</h3>
          <ul className="folders">
            {last.map((d) => (
              <li key={d}>
                <button className="project" onClick={() => onOpen(d)}>
                  ▶ {d}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {b && (
        <>
          <h3>{b.dir}</h3>
          <ul className="folders">
            {b.parent && (
              <li>
                <button onClick={() => void go(b.parent!)}>⬑ ..</button>
              </li>
            )}
            {b.folders.map((f) => (
              <li key={f.path}>
                {f.project ? (
                  <button className="project" onClick={() => onOpen(f.path)} title="Open this project">
                    ▶ {f.name}
                  </button>
                ) : (
                  <button onClick={() => void go(f.path)}>📁 {f.name}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
