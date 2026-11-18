import { useEffect, useMemo, useState } from 'react';
import { api, type PoolFile } from '../api';
import { useStudio } from '../store';

const ICON: Record<string, string> = { video: '🎞', audio: '🔊', image: '🖼', other: '📄' };

function size(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The project folder, live: what's there, and which files the timeline uses. */
export function MediaPool() {
  const s = useStudio();
  const dir = s.opened?.dir;
  const [files, setFiles] = useState<PoolFile[]>([]);
  const [filter, setFilter] = useState<'media' | 'all'>('media');

  useEffect(() => {
    if (!dir) return;
    let alive = true;
    const load = () => api.pool(dir).then((r) => alive && setFiles(r.files), () => {});
    void load();
    const t = window.setInterval(load, 5000); // pick up files added to the folder
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [dir]);

  const used = useMemo(() => {
    const set = new Set<string>();
    for (const m of Object.values(s.opened?.media ?? {})) set.add(m.path.toLowerCase());
    return set;
  }, [s.opened]);

  const shown = files.filter((f) => filter === 'all' || f.kind !== 'other');
  const groups = new Map<string, PoolFile[]>();
  for (const f of shown) {
    const folder = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '.';
    (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(f);
  }

  return (
    <aside className="pool panel">
      <div className="panel-head">
        <span>Media</span>
        <select title="Show only media files, or every file in the project" value={filter} onChange={(e) => setFilter(e.target.value as 'media' | 'all')}>
          <option value="media">media</option>
          <option value="all">all files</option>
        </select>
      </div>
      <div className="panel-body">
        {[...groups.entries()].map(([folder, fs]) => (
          <div key={folder} className="pool-group">
            <div className="pool-folder">{folder}</div>
            {fs.map((f) => (
              <div
                key={f.path}
                className={`pool-file ${used.has(f.path.toLowerCase()) ? 'used' : ''}`}
                draggable={f.kind !== 'other'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/mango-path', f.path);
                  e.dataTransfer.setData('text/mango-kind', f.kind);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={`${f.rel} · ${size(f.size)}${used.has(f.path.toLowerCase()) ? ' · on the timeline' : ''} · drag onto the timeline to add it`}
              >
                <span>{ICON[f.kind] ?? '📄'}</span>
                <span className="name">{f.rel.split('/').pop()}</span>
                <span className="muted small">{size(f.size)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
