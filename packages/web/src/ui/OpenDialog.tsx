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
        <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} title="A folder path; press Enter to browse it" />
        <button type="submit" title="Browse this folder">Go</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel} title="Back to the open project">
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
                <button className="project" onClick={() => onOpen(d)} title="Open this recent project">
                  ▶ {d}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {b && <FromTemplate dir={b.dir} isProject={b.isProject} onOpen={onOpen} />}
      {b && (
        <>
          <h3>{b.dir}</h3>
          <ul className="folders">
            {b.parent && (
              <li>
                <button onClick={() => void go(b.parent!)} title="Up one folder">⬑ ..</button>
              </li>
            )}
            {b.folders.map((f) => (
              <li key={f.path}>
                {f.project ? (
                  <button className="project" onClick={() => onOpen(f.path)} title="Open this project">
                    ▶ {f.name}
                  </button>
                ) : (
                  <button onClick={() => void go(f.path)} title="Open this folder">📁 {f.name}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Start a new project in this folder (or a new subfolder) from a saved template. */
function FromTemplate({ dir, isProject, onOpen }: { dir: string; isProject?: boolean | undefined; onOpen: (dir: string) => void }) {
  const [list, setList] = useState<{ name: string; tracks: number; clips: number; size: string }[]>([]);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ templates: typeof list }>('/api/templates').then((r) => {
      setList(r.templates);
      setName((n) => n || r.templates[0]?.name || '');
    }, () => setList([]));
  }, []);
  if (!list.length) return null;
  const target = folder.trim() ? `${dir.replace(/[\/]$/, '')}/${folder.trim()}` : dir;
  const create = async () => {
    try {
      await api.post('/api/template/new', { dir: target, name, ...(folder.trim() && { title: folder.trim() }) });
      onOpen(target);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="from-template small">
      <b title="Saved with Save as template in a project's Inspector">New from a template</b>
      <select value={name} onChange={(e) => setName(e.target.value)} title="Which template">
        {list.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.size}, {t.tracks} tracks{t.clips ? `, ${t.clips} clips` : ''})
          </option>
        ))}
      </select>
      <input placeholder={isProject ? 'new folder name (needed: this folder has a project)' : 'new folder name (optional)'} value={folder} onChange={(e) => setFolder(e.target.value)} title="Make a new folder here for the project; leave empty to use this folder" />
      <button disabled={!name || (isProject && !folder.trim())} onClick={() => void create()} title={`Write cut.json in ${target} and open it`}>
        Create
      </button>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}
