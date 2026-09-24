import React, { useState } from 'react';
import type { BaseLayer, CreateProjectOptions } from '../api/client';

interface Props {
  onClose: () => void;
  onCreate: (name: string, opts: CreateProjectOptions) => Promise<void>;
}

type BaseChoice = 'video' | 'color' | 'gradient' | 'transparent';

const RESOLUTIONS: { label: string; width: number; height: number }[] = [
  { label: '1920 × 1080 (landscape)', width: 1920, height: 1080 },
  { label: '1080 × 1920 (portrait)', width: 1080, height: 1920 },
  { label: '1080 × 1080 (square)', width: 1080, height: 1080 },
  { label: '1280 × 720 (landscape, small)', width: 1280, height: 720 },
];

const FPS = 30;

export const CreateProjectModal: React.FC<Props> = ({ onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [baseChoice, setBaseChoice] = useState<BaseChoice>('video');
  const [color, setColor] = useState('#ffffff');
  const [gradientFrom, setGradientFrom] = useState('#6366f1');
  const [gradientTo, setGradientTo] = useState('#ec4899');
  const [gradientAngle, setGradientAngle] = useState(45);
  const [durationSeconds, setDurationSeconds] = useState(10);
  const [resolutionIndex, setResolutionIndex] = useState(0);
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustomResolution = resolutionIndex === RESOLUTIONS.length;
  const width = isCustomResolution ? customWidth : RESOLUTIONS[resolutionIndex].width;
  const height = isCustomResolution ? customHeight : RESOLUTIONS[resolutionIndex].height;

  const gradientPreview = `linear-gradient(${gradientAngle}deg, ${gradientFrom}, ${gradientTo})`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      if (baseChoice === 'video') {
        await onCreate(name.trim(), {});
        return;
      }
      const baseLayer: BaseLayer =
        baseChoice === 'color'
          ? { type: 'color', color }
          : baseChoice === 'gradient'
          ? { type: 'gradient', from: gradientFrom, to: gradientTo, angle: gradientAngle }
          : { type: 'transparent' };
      await onCreate(name.trim(), {
        baseLayer,
        fps: FPS,
        width,
        height,
        durationInFrames: Math.max(1, Math.round(durationSeconds * FPS)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !creating && onClose()}>
      <form className="modal" role="dialog" aria-label="New project" onSubmit={handleSubmit} style={{ width: 520 }}>
        <div className="modal-header">
          <h3 className="inspector-heading" style={{ margin: 0 }}>
            New project
          </h3>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={creating} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="field-wrap">
            <span className="field-label">Name</span>
            <input
              className="field-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
            />
          </label>

          <div>
            <span className="field-label">Starting point</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <label className={`btn btn-sm ${baseChoice === 'video' ? 'btn-primary' : ''}`} style={{ flex: 1, textAlign: 'center' }}>
                <input type="radio" name="baseChoice" value="video" checked={baseChoice === 'video'} onChange={() => setBaseChoice('video')} style={{ display: 'none' }} />
                Upload a video
              </label>
              <label className={`btn btn-sm ${baseChoice !== 'video' ? 'btn-primary' : ''}`} style={{ flex: 1, textAlign: 'center' }}>
                <input
                  type="radio"
                  name="baseChoice"
                  value="blank"
                  checked={baseChoice !== 'video'}
                  onChange={() => setBaseChoice('color')}
                  style={{ display: 'none' }}
                />
                Start blank
              </label>
            </div>
          </div>

          {baseChoice === 'video' && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              You'll upload a video once the project is created. Duration and canvas size are read from it automatically.
            </div>
          )}

          {baseChoice !== 'video' && (
            <>
              <div>
                <span className="field-label">Background</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['color', 'gradient', 'transparent'] as const).map((choice) => (
                    <label
                      key={choice}
                      className={`btn btn-sm ${baseChoice === choice ? 'btn-primary' : ''}`}
                      style={{ flex: 1, textAlign: 'center', textTransform: 'capitalize' }}
                    >
                      <input
                        type="radio"
                        name="blankType"
                        value={choice}
                        checked={baseChoice === choice}
                        onChange={() => setBaseChoice(choice)}
                        style={{ display: 'none' }}
                      />
                      {choice}
                    </label>
                  ))}
                </div>
              </div>

              {baseChoice === 'color' && (
                <label className="field-wrap">
                  <span className="field-label">Color</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                    <input
                      className="field-input"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      style={{ width: 100 }}
                    />
                  </div>
                </label>
              )}

              {baseChoice === 'gradient' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <label className="field-wrap" style={{ flex: 1 }}>
                      <span className="field-label">From</span>
                      <input type="color" value={gradientFrom} onChange={(e) => setGradientFrom(e.target.value)} style={{ width: '100%' }} />
                    </label>
                    <label className="field-wrap" style={{ flex: 1 }}>
                      <span className="field-label">To</span>
                      <input type="color" value={gradientTo} onChange={(e) => setGradientTo(e.target.value)} style={{ width: '100%' }} />
                    </label>
                    <label className="field-wrap" style={{ flex: 1 }}>
                      <span className="field-label">Angle</span>
                      <input
                        type="number"
                        className="field-input"
                        min={0}
                        max={360}
                        value={gradientAngle}
                        onChange={(e) => setGradientAngle(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <div style={{ height: 40, borderRadius: 6, background: gradientPreview, border: '1px solid var(--border)' }} />
                </div>
              )}

              {baseChoice === 'transparent' && (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                  No background at all — the exported overlay is a transparent video, ready to layer over anything else.
                </div>
              )}

              <div style={{ display: 'flex', gap: 12 }}>
                <label className="field-wrap" style={{ flex: 1 }}>
                  <span className="field-label">Duration (seconds)</span>
                  <input
                    type="number"
                    className="field-input"
                    min={1}
                    value={durationSeconds}
                    onChange={(e) => setDurationSeconds(Number(e.target.value))}
                  />
                </label>
                <label className="field-wrap" style={{ flex: 2 }}>
                  <span className="field-label">Resolution</span>
                  <select
                    className="field-select"
                    value={resolutionIndex}
                    onChange={(e) => setResolutionIndex(Number(e.target.value))}
                  >
                    {RESOLUTIONS.map((r, i) => (
                      <option key={r.label} value={i}>
                        {r.label}
                      </option>
                    ))}
                    <option value={RESOLUTIONS.length}>Custom</option>
                  </select>
                </label>
              </div>

              {isCustomResolution && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <label className="field-wrap" style={{ flex: 1 }}>
                    <span className="field-label">Width</span>
                    <input type="number" className="field-input" min={1} value={customWidth} onChange={(e) => setCustomWidth(Number(e.target.value))} />
                  </label>
                  <label className="field-wrap" style={{ flex: 1 }}>
                    <span className="field-label">Height</span>
                    <input type="number" className="field-input" min={1} value={customHeight} onChange={(e) => setCustomHeight(Number(e.target.value))} />
                  </label>
                </div>
              )}
            </>
          )}

          {error && <div style={{ fontSize: 12.5, color: 'var(--error)' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={creating} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
              {creating ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
