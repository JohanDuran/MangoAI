import React, { useEffect, useRef, useState } from 'react';
import { deleteMusic, updateMusic, uploadMusic, type MusicState } from '../api/client';

interface Props {
  projectId: string;
  state: MusicState | null;
  onChange: (state: MusicState) => void;
  onClose: () => void;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

// Background music: one track for the whole video, turned down while someone speaks.
export const MusicDialog: React.FC<Props> = ({ projectId, state, onChange, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(state?.music?.volume ?? 0.35);
  const fileRef = useRef<HTMLInputElement>(null);
  const music = state?.music ?? null;

  useEffect(() => {
    if (music) setVolume(music.volume);
  }, [music?.file]);

  // The slider saves shortly after it stops moving.
  useEffect(() => {
    if (!music || Math.abs(volume - music.volume) < 0.001) return;
    const timer = setTimeout(() => run(() => updateMusic(projectId, { volume })), 300);
    return () => clearTimeout(timer);
  }, [volume]);

  const run = async (action: () => Promise<MusicState>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Music">
        <div className="modal-header">
          <h3 className="inspector-heading" style={{ margin: 0 }}>
            Music
          </h3>
          <div style={{ flex: 1 }} />
          {busy && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Saving…</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="panel-hint">
          A background track for the whole video. It plays in the preview and is mixed into the MP4; an overlay-only export
          saves it as music.wav. Use music you have the rights to.
        </div>
        {error && <div className="field-error">{error}</div>}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) run(() => uploadMusic(projectId, file));
          }}
        />
        {!music ? (
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Adding…' : 'Choose an audio file'}
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{music.name}</span>
              <span style={{ color: 'var(--text-faint)' }}>{fmtTime(music.durationSec)}</span>
              <div style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                Replace
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await deleteMusic(projectId);
                    return { ...(state as MusicState), music: null };
                  })
                }
              >
                Remove
              </button>
            </div>
            <label className="volume-control" style={{ maxWidth: 360 }}>
              <span>Volume</span>
              <input type="range" min={0} max={100} step={1} value={Math.round(volume * 100)} onChange={(e) => setVolume(Number(e.target.value) / 100)} />
              <span className="volume-value">{volume === 0 ? 'Muted' : `${Math.round(volume * 100)}%`}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={music.loop} disabled={busy} onChange={(e) => run(() => updateMusic(projectId, { loop: e.target.checked }))} />
              Loop it to the end of the video
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={music.duck} disabled={busy} onChange={(e) => run(() => updateMusic(projectId, { duck: e.target.checked }))} />
              Turn it down while someone speaks ({state?.intervals.length ?? 0} stretch{state?.intervals.length === 1 ? '' : 'es'} of
              voiceover or speech in the video)
            </label>
          </div>
        )}
      </div>
    </div>
  );
};
