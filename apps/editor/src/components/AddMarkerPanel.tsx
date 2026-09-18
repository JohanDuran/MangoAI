import React, { useState } from 'react';
import type { MarkerRegion } from '../api/client';
import { formatRegion } from '../format';

interface Props {
  currentTime: number;
  start: number;
  end: number;
  onStartChange: (seconds: number) => void;
  onEndChange: (seconds: number) => void;
  onAdd: (input: { start: number; end: number; prompt: string; allowImage: boolean }) => void;
  region: MarkerRegion | null;
  editingRegion: boolean;
  onStartEditRegion: () => void;
  onDoneEditRegion: () => void;
  onResetRegion: () => void;
}

const fmt = (seconds: number) => seconds.toFixed(1);

export const AddMarkerPanel: React.FC<Props> = ({
  currentTime,
  start,
  end,
  onStartChange,
  onEndChange,
  onAdd,
  region,
  editingRegion,
  onStartEditRegion,
  onDoneEditRegion,
  onResetRegion,
}) => {
  const [prompt, setPrompt] = useState('');
  const [allowImage, setAllowImage] = useState(false);
  const canAdd = prompt.trim().length > 0 && end > start;

  return (
    <div className="panel">
      <div className="panel-hint">
        Play the video and click "Capture start" / "Capture end", or drag across the timeline above.
      </div>
      <div className="capture-row">
        <span className="capture-label">Start</span>
        <input
          type="number"
          value={start}
          onChange={(e) => onStartChange(Number(e.target.value))}
          className="capture-time"
          aria-label="start seconds"
        />
        <button type="button" className="btn btn-sm" onClick={() => onStartChange(Number(fmt(currentTime)))}>
          Capture start ({fmt(currentTime)}s)
        </button>
        <span className="capture-label" style={{ marginLeft: 8 }}>
          End
        </span>
        <input
          type="number"
          value={end}
          onChange={(e) => onEndChange(Number(e.target.value))}
          className="capture-time"
          aria-label="end seconds"
        />
        <button type="button" className="btn btn-sm" onClick={() => onEndChange(Number(fmt(currentTime)))}>
          Capture end ({fmt(currentTime)}s)
        </button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <span className="capture-label" style={{ display: 'block', marginBottom: 6 }}>
          Animation area
        </span>
        {editingRegion ? (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              Drag on the preview above to draw, move, or resize the area this animation will be confined to.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={onResetRegion}>
                Full screen
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onDoneEditRegion}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{formatRegion(region)}</span>
            <button type="button" className="btn btn-sm" onClick={onStartEditRegion}>
              Edit area
            </button>
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canAdd) return;
          onAdd({ start, end, prompt, allowImage });
          setPrompt('');
          setAllowImage(false);
        }}
        className="add-marker-row"
      >
        <input
          className="field-input"
          placeholder="Describe the overlay (e.g. 'animated bar chart of tax prep time')"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!canAdd}>
          Add marker &amp; generate
        </button>
      </form>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
        <input type="checkbox" checked={allowImage} onChange={(e) => setAllowImage(e.target.checked)} />
        Needs a generated image (generates one via OpenAI before writing the code)
      </label>
      {end <= start && <div className="field-error">End must be after start.</div>}
    </div>
  );
};
