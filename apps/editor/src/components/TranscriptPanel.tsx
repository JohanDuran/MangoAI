import React, { useState } from 'react';
import type { TranscriptSegment } from '../api/client';

interface Props {
  segments: TranscriptSegment[];
  onSave: (segments: TranscriptSegment[]) => Promise<void>;
  onClose: () => void;
  onSeek: (seconds: number) => void;
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

// Shown right after transcribing (and reopenable any time after) so the creator can check
// Whisper got things right — and fix it inline, since a wrong word here quietly propagates
// into "said in the video" context and into what the marker planner reads.
export const TranscriptPanel: React.FC<Props> = ({ segments, onSave, onClose, onSeek }) => {
  const [edited, setEdited] = useState(segments);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = edited.some((s, i) => s.text !== segments[i]?.text);

  const handleClose = () => {
    if (dirty && !window.confirm('Discard unsaved changes to the transcript?')) return;
    onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(edited);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && handleClose()}>
      <div className="modal" role="dialog" aria-label="Transcript">
        <div className="modal-header">
          <h3 className="inspector-heading" style={{ margin: 0 }}>
            Transcript
          </h3>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
            Close
          </button>
        </div>
        <div className="panel-hint">
          Fix anything Whisper misheard. Click a timestamp to jump the preview there. Saved corrections are used both by
          the marker planner and as "said in the video" context for individual markers.
        </div>
        {error && <div className="field-error">{error}</div>}
        {edited.length === 0 ? (
          <div className="inspector-empty">No transcript yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {edited.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                  onClick={() => onSeek(s.start)}
                  title="Jump the preview to this time"
                >
                  {fmtTime(s.start)}–{fmtTime(s.end)}
                </button>
                <textarea
                  className="field-textarea"
                  rows={2}
                  style={{ flex: 1 }}
                  value={s.text}
                  onChange={(e) => {
                    const text = e.target.value;
                    setEdited((prev) => prev.map((seg, j) => (j === i ? { ...seg, text } : seg)));
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
