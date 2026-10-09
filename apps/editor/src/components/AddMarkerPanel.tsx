import React, { useState } from 'react';
import type { Asset, MarkerRegion, VoiceOptions } from '../api/client';
import { estimateSpeechSeconds } from './VoiceoverSection';
import { AssetPicker } from './AssetPicker';
import { VoiceSampleButton } from './VoiceSampleButton';
import { formatRegion } from '../format';

interface Props {
  projectId: string;
  assets: Asset[];
  onUploadAssets: (files: File[]) => Promise<Asset[]>;
  currentTime: number;
  start: number;
  end: number;
  onStartChange: (seconds: number) => void;
  onEndChange: (seconds: number) => void;
  onAdd: (input: { start: number; end: number; prompt: string; allowImage: boolean; assets: string[]; narration?: { text: string; voice: string } }) => void;
  region: MarkerRegion | null;
  editingRegion: boolean;
  onStartEditRegion: () => void;
  onDoneEditRegion: () => void;
  onResetRegion: () => void;
  voices: VoiceOptions | null;
  defaultVoice: string;
}

const fmt = (seconds: number) => seconds.toFixed(1);

export const AddMarkerPanel: React.FC<Props> = ({
  projectId,
  assets,
  onUploadAssets,
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
  voices,
  defaultVoice,
}) => {
  const [prompt, setPrompt] = useState('');
  const [narration, setNarration] = useState('');
  const [voice, setVoice] = useState<string | null>(null);
  const spokenSeconds = estimateSpeechSeconds(narration);
  const [allowImage, setAllowImage] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
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
          onAdd({
            start,
            end,
            prompt,
            allowImage,
            assets: attached,
            ...(narration.trim() && { narration: { text: narration.trim(), voice: voice ?? defaultVoice } }),
          });
          setPrompt('');
          setNarration('');
          setAllowImage(false);
          setAttached([]);
        }}
        className="add-marker-row"
      >
        <textarea
          className="field-textarea"
          rows={4}
          placeholder="Describe the overlay (e.g. 'animated bar chart of tax prep time')"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <textarea
          className="field-textarea"
          rows={2}
          maxLength={voices?.maxChars ?? 4096}
          placeholder="Voiceover (optional): words a voice reads aloud from the start"
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
        />
        {narration.trim() && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-faint)' }}>
            <select
              className="field-select"
              style={{ width: 'auto', padding: '5px 8px' }}
              value={voice ?? defaultVoice}
              onChange={(e) => setVoice(e.target.value)}
              aria-label="Voice"
              title="Voice"
            >
              {(voices?.voices ?? [defaultVoice]).map((v) => (
                <option key={v} value={v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
            <VoiceSampleButton voice={voice ?? defaultVoice} disabled={!voices} />
            <span style={{ color: spokenSeconds > end - start ? 'var(--mango)' : undefined }}>
              About {spokenSeconds.toFixed(1)}s when spoken · marker {Math.max(0, end - start).toFixed(1)}s
              {spokenSeconds > end - start ? ' (consider a longer range)' : ''}
            </span>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={!canAdd}>
          Add marker &amp; generate
        </button>
      </form>
      <div style={{ marginTop: 12 }}>
        <span className="capture-label" style={{ display: 'block', marginBottom: 6 }}>
          Images for context (optional)
        </span>
        <AssetPicker projectId={projectId} assets={assets} selected={attached} onChange={setAttached} onUpload={onUploadAssets} />
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          Claude looks at the selected images and decides how to use them, e.g. a logo in a corner or a screenshot in a card.
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
        <input type="checkbox" checked={allowImage} onChange={(e) => setAllowImage(e.target.checked)} />
        Allow AI image generation (Claude may generate one via OpenAI if it fits the request)
      </label>
      {end <= start && <div className="field-error">End must be after start.</div>}
    </div>
  );
};
