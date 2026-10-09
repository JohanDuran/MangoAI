import React, { useEffect, useState } from 'react';
import { getMarkerCode, type Asset, type Marker, type MarkerRegion, type TranscriptSegment, type VoiceOptions } from '../api/client';
import { VoiceoverSection } from './VoiceoverSection';
import { AssetPicker } from './AssetPicker';
import type { MarkerRunState } from '../App';
import { displayStatus } from '../status';
import { StatusBadge } from './StatusBadge';
import { formatRegion } from '../format';

interface Props {
  projectId: string;
  assets: Asset[];
  onUploadAssets: (files: File[]) => Promise<Asset[]>;
  onSetAssets: (markerId: string, ids: string[]) => Promise<void>;
  marker: Marker | null;
  run?: MarkerRunState;
  transcript: TranscriptSegment[];
  onRegenerate: (markerId: string, feedback: string, allowImage: boolean) => void;
  // Stops the generation running for this marker; its previous code is put back.
  onStop: (markerId: string) => void;
  stopping: boolean;
  onDelete: (markerId: string) => void;
  regionStale: boolean;
  regionEditing: boolean;
  regionDraft: MarkerRegion | null;
  onStartEditRegion: (markerId: string) => void;
  onCancelEditRegion: () => void;
  onResetRegionDraft: () => void;
  onSaveRegion: () => void;
  voices: VoiceOptions | null;
  defaultVoice: string;
  onGenerateVoice: (markerId: string, text: string, voice: string) => Promise<void>;
}

export const MarkerInspector: React.FC<Props> = ({
  projectId,
  assets,
  onUploadAssets,
  onSetAssets,
  marker,
  run,
  transcript,
  onRegenerate,
  onStop,
  stopping,
  onDelete,
  regionStale,
  regionEditing,
  regionDraft,
  onStartEditRegion,
  onCancelEditRegion,
  onResetRegionDraft,
  onSaveRegion,
  voices,
  defaultVoice,
  onGenerateVoice,
}) => {
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [allowImage, setAllowImage] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Switching markers (or losing the selection entirely) implicitly abandons any
  // in-progress "are you sure?" delete confirmation for the previous one.
  useEffect(() => {
    setConfirmingDelete(false);
  }, [marker?.marker_id]);

  // Refetch the displayed code whenever generation finishes (or the selected marker
  // changes) — but NOT the feedback text below, which the user may be actively typing.
  useEffect(() => {
    if (!marker) return;
    getMarkerCode(projectId, marker.marker_id).then(setCode);
  }, [projectId, marker?.marker_id, run?.phase]);

  // Only reset the feedback draft when switching to a different marker. Resetting it on
  // every run?.phase change (e.g. right when you click Regenerate) would stomp whatever
  // you just typed with the server's stale (pre-regenerate) feedback value.
  useEffect(() => {
    if (!marker) return;
    setFeedback(marker.feedback);
  }, [projectId, marker?.marker_id]);

  if (!marker) {
    return <div className="inspector-empty">Select a marker on the timeline to see its status, or add one above.</div>;
  }

  const status = displayStatus(marker, run);
  const generating = status === 'generating';

  let statusLine: string;
  if (generating) statusLine = 'Generating — Claude is writing this overlay now.';
  else if (status === 'error') {
    const errorMessage = run?.phase === 'done' ? run.error : undefined;
    statusLine = `Failed${errorMessage ? `: ${errorMessage}` : ''}. Adjust the feedback below and try again.`;
  } else if (status === 'ready') statusLine = 'Ready — shown in the preview above. Not right? Add feedback and regenerate.';
  else statusLine = 'Not generated yet.';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h3 className="inspector-heading" style={{ margin: 0 }}>
          Marker {marker.marker_id}
        </h3>
        <StatusBadge status={status} />
        <div style={{ flex: 1 }} />
        {confirmingDelete ? (
          <>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Delete this animation?</span>
            <button
              type="button"
              className="btn btn-sm"
              style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
              onClick={() => onDelete(marker.marker_id)}
            >
              Confirm
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        )}
      </div>

      <div className={`status-line status-${status}`}>{statusLine}</div>

      {generating && run && run.log.length > 0 && (
        <div className="run-log">
          {run.log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {transcript.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>
          <span className="field-label" style={{ marginBottom: 4 }}>
            Said in the video during this range
          </span>
          "{transcript.map((s) => s.text).join(' ')}"
        </div>
      )}

      <label className="field-label">Animation area</label>
      {regionEditing ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            Drag on the preview above to draw, move, or resize the area this animation is confined to.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-region-controls>
            <button type="button" className="btn btn-sm" onClick={onResetRegionDraft}>
              Full screen
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onSaveRegion}>
              Save area
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelEditRegion}>
              Cancel
            </button>
          </div>
          {regionDraft && (
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
              {Math.round(regionDraft.width * 100)}% × {Math.round(regionDraft.height * 100)}% at (
              {Math.round(regionDraft.x * 100)}%, {Math.round(regionDraft.y * 100)}%)
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{formatRegion(marker.region)}</span>
          <button type="button" className="btn btn-sm" onClick={() => onStartEditRegion(marker.marker_id)}>
            Edit area
          </button>
        </div>
      )}
      {!regionEditing && regionStale && (
        <div
          className="status-line status-error"
          style={{ marginTop: -8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 auto' }}>
            The area was resized — the current animation was designed for the old size and may no longer fit.
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={generating}
            onClick={() => onRegenerate(marker.marker_id, feedback, allowImage)}
          >
            Regenerate to fit
          </button>
        </div>
      )}
      {!regionEditing && !regionStale && marker.region && marker.status === 'ready' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: -8, marginBottom: 14 }}>
          Tip: click Regenerate below so the animation redesigns itself to fit this area.
        </div>
      )}

      <VoiceoverSection
        projectId={projectId}
        marker={marker}
        voices={voices}
        defaultVoice={defaultVoice}
        onGenerate={onGenerateVoice}
      />

      <label className="field-label">Images for context</label>
      <div style={{ marginBottom: 14 }}>
        <AssetPicker
          projectId={projectId}
          assets={assets}
          selected={marker.assets ?? []}
          onChange={(ids) => onSetAssets(marker.marker_id, ids).catch(() => {})}
          onUpload={onUploadAssets}
          disabled={generating}
        />
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>
          Changes to the attached images apply the next time you {marker.status === 'draft' ? 'generate' : 'regenerate'}.
        </div>
      </div>

      <label className="field-label">{marker.status === 'draft' ? 'Prompt' : 'Feedback for the next attempt'}</label>
      <textarea
        className="field-textarea"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="e.g. 'make the entrance faster and use a dark navy background'"
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)', margin: '8px 0' }}>
        <input type="checkbox" checked={allowImage} onChange={(e) => setAllowImage(e.target.checked)} />
        Allow AI image generation (Claude may generate one via OpenAI if it fits the request)
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onRegenerate(marker.marker_id, feedback, allowImage)}
          disabled={generating}
          className="btn btn-primary"
        >
          {generating ? 'Generating…' : marker.status === 'draft' ? 'Generate' : 'Regenerate'}
        </button>
        {generating && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={stopping}
            onClick={() => onStop(marker.marker_id)}
            title="Stop Claude now and keep the animation this marker had before"
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      <div className="code-toggle">
        <button onClick={() => setShowCode((v) => !v)} className="btn btn-ghost btn-sm">
          {showCode ? 'Hide code' : 'View code'}
        </button>
        {showCode && <pre className="code-view">{code}</pre>}
      </div>
    </div>
  );
};
