import React, { useEffect, useState } from 'react';
import type { Marker, StylePreset } from '../api/client';
import { formatRegion } from '../format';

interface Props {
  marker: Marker;
  presets: StylePreset[];
  onSetStyle: (markerId: string, presetId: string | null) => Promise<void>;
  onApplyArea: (markerId: string) => Promise<void>;
  onSaveStyle: (markerId: string, name: string) => Promise<void>;
  disabled?: boolean;
}

// A marker's style: which saved look the next generation matches, and saving this marker's own look.
export const StyleSection: React.FC<Props> = ({ marker, presets, onSetStyle, onApplyArea, onSaveStyle, disabled }) => {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setNaming(false);
    setName('');
    setError(null);
    setSaved(null);
  }, [marker.marker_id]);

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

  const current = presets.find((p) => p.id === marker.stylePreset);
  const areaDiffers = current && JSON.stringify(current.region ?? null) !== JSON.stringify(marker.region ?? null);

  return (
    <div style={{ marginBottom: 14 }}>
      <label className="field-label">Style</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          className="field-select"
          style={{ width: 'auto', padding: '5px 8px', maxWidth: 220 }}
          value={current ? current.id : ''}
          disabled={busy || disabled}
          onChange={(e) => run(() => onSetStyle(marker.marker_id, e.target.value || null))}
          title="The next generation matches this saved look"
        >
          <option value="">No style</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {areaDiffers && (
          <button type="button" className="btn btn-sm" disabled={busy || disabled} onClick={() => run(() => onApplyArea(marker.marker_id))}>
            Use its area ({formatRegion(current.region).replace('Custom area — ', '')})
          </button>
        )}
        {marker.status === 'ready' && !naming && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setNaming(true)}>
            Save this look as a style
          </button>
        )}
      </div>
      {naming && (
        <form
          style={{ display: 'flex', gap: 8, marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            run(async () => {
              await onSaveStyle(marker.marker_id, name);
              setSaved(name.trim());
              setNaming(false);
              setName('');
            });
          }}
        >
          <input
            className="field-input"
            autoFocus
            maxLength={60}
            placeholder="Style name, e.g. Navy cards"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
            Save
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      )}
      {current && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          The next {marker.status === 'draft' ? 'generation' : 'regenerate'} matches the look of "{current.name}" (from {current.fromProject}).
        </div>
      )}
      {saved && <div style={{ fontSize: 11.5, color: 'var(--ready)', marginTop: 6 }}>Saved "{saved}". Pick it for other markers, or as the project's style.</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};
