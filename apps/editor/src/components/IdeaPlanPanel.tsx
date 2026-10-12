import React from 'react';
import type { MarkerRegion } from '../api/client';
import { formatRegion } from '../format';
import { VoicePicker } from './VoicePicker';

interface Props {
  planning: boolean;
  stopping: boolean;
  error: string | null;
  // The idea text, kept by the parent so it survives the panel being hidden.
  idea: string;
  onIdeaChange: (idea: string) => void;
  // Shown above the form, e.g. to say an earlier plan was interrupted.
  notice?: string | null;
  // The area every designed marker is confined to; null leaves each marker's area to Claude.
  region: MarkerRegion | null;
  editingRegion: boolean;
  onStartEditRegion: () => void;
  onDoneEditRegion: () => void;
  onResetRegion: () => void;
  // Whether Claude also writes a voiceover line for each marker.
  narration: boolean;
  onNarrationChange: (value: boolean) => void;
  // The voice the lines are read in (the project's voice until another is picked here).
  voices: string[] | null;
  voice: string;
  onVoiceChange: (voice: string) => void;
  onStop: () => void;
  onSubmit: (idea: string) => void;
  onCancel: () => void;
}

export const IdeaPlanPanel: React.FC<Props> = ({
  planning,
  stopping,
  error,
  idea,
  onIdeaChange,
  notice,
  region,
  editingRegion,
  onStartEditRegion,
  onDoneEditRegion,
  onResetRegion,
  narration,
  onNarrationChange,
  voices,
  voice,
  onVoiceChange,
  onStop,
  onSubmit,
  onCancel,
}) => {
  const canSubmit = idea.trim().length > 0 && !planning;

  return (
    <div className="panel">
      {notice && <div className="panel-hint plan-interrupted">{notice}</div>}
      <div className="panel-hint">
        Describe what the video should cover. Claude will design a full sequence of correlated markers spanning the
        whole duration, not just one.
      </div>
      <div style={{ marginBottom: 12 }}>
        <span className="capture-label" style={{ display: 'block', marginBottom: 6 }}>
          Area for all markers
        </span>
        {editingRegion ? (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              Drag on the preview above to draw, move, or resize the area every designed marker will be confined to.
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
            <button type="button" className="btn btn-sm" onClick={onStartEditRegion} disabled={planning}>
              Edit area
            </button>
            {region && (
              <button type="button" className="btn btn-sm" onClick={onResetRegion} disabled={planning}>
                Full screen
              </button>
            )}
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit(idea);
        }}
        className="add-marker-row"
      >
        <textarea
          className="field-textarea"
          rows={8}
          placeholder={
            'e.g. "This ~60s video compares investing $200/mo from age 20-60 vs. age 30-60. Design markers that build up the comparison and land on the final numbers."'
          }
          value={idea}
          onChange={(e) => onIdeaChange(e.target.value)}
          disabled={planning}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={narration} onChange={(e) => onNarrationChange(e.target.checked)} disabled={planning} />
          Write a voiceover: Claude adds a spoken line to each marker, read aloud by an AI voice from OpenAI (tell your viewers it is AI-generated)
        </label>
        {narration && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 22 }}>
            Read by
            <VoicePicker voices={voices} value={voice} onChange={onVoiceChange} disabled={planning} title="The voice for this plan's voiceover" />
          </label>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {planning ? 'Designing…' : 'Design markers'}
          </button>
          {planning ? (
            <button type="button" className="btn btn-sm btn-danger" onClick={onStop} disabled={stopping} title="Stop Claude and throw this plan away">
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};
