import React, { useState } from 'react';

interface Props {
  currentTime: number;
  start: number;
  end: number;
  onStartChange: (seconds: number) => void;
  onEndChange: (seconds: number) => void;
  onAdd: (input: { start: number; end: number; prompt: string; allowImage: boolean }) => void;
}

const fmt = (seconds: number) => seconds.toFixed(1);

export const AddMarkerPanel: React.FC<Props> = ({ currentTime, start, end, onStartChange, onEndChange, onAdd }) => {
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
