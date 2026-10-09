import React, { useState } from 'react';
import type { StylePreset } from '../api/client';
import { formatRegion } from '../format';

interface Props {
  presets: StylePreset[];
  projectStyle: string | null;
  onSetProjectStyle: (presetId: string | null) => Promise<void>;
  onDelete: (presetId: string) => Promise<void>;
  onClose: () => void;
}

// Saved styles, shared by every project, and the one this project's new markers start with.
export const StylesDialog: React.FC<Props> = ({ presets, projectStyle, onSetProjectStyle, onDelete, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Styles">
        <div className="modal-header">
          <h3 className="inspector-heading" style={{ margin: 0 }}>
            Styles
          </h3>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="panel-hint">
          A style is the look of an animation you liked: its colors, fonts, sizes and motion. Save one from a generated marker
          (in its inspector), then pick it for other markers so Claude matches it. Styles are shared by all your projects.
        </div>
        {error && <div className="field-error">{error}</div>}
        <label className="capture-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' }}>
          New markers in this project start with
          <select
            className="field-select"
            style={{ width: 'auto', padding: '5px 8px' }}
            value={projectStyle ?? ''}
            disabled={busy}
            onChange={(e) => run(() => onSetProjectStyle(e.target.value || null))}
          >
            <option value="">No style</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {presets.length === 0 ? (
          <div className="inspector-empty">No styles yet. Open a generated marker and choose "Save this look as a style".</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {presets.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                  from {p.fromProject} · {formatRegion(p.region)}
                </span>
                <div style={{ flex: 1 }} />
                {confirming === p.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
                      disabled={busy}
                      onClick={() => run(() => onDelete(p.id)).then(() => setConfirming(null))}
                    >
                      Delete
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(p.id)} title="Markers using it keep their current animation">
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
