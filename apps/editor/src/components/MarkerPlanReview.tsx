import React from 'react';
import type { Asset, Marker, PlanItem, PlanSource } from '../api/client';
import { AssetPicker } from './AssetPicker';
import { estimateSpeechSeconds } from './VoiceoverSection';
import type { MarkerRunState } from '../App';
import type { DisplayStatus } from '../status';
import { StatusBadge } from './StatusBadge';
import { formatRegion } from '../format';

// Proposed markers are saved on the runner as they are edited, so review items are plan items.
// An item gets a markerId once applying the plan created its marker; error is set when the server
// rejected it before it could be created (e.g. an edited time range now overlaps another marker).
export type ReviewItem = PlanItem;

// Passed as editingRegionKey while one area is being drawn for every item still to generate.
export const ALL_AREAS_KEY = '*';

// An item is finished once its marker exists and has been generated (successfully or not). A marker
// still in draft was left behind by an interrupted apply and is made again on the next apply.
export const isItemDone = (item: ReviewItem, markers: Marker[]): boolean => {
  if (!item.markerId) return false;
  const marker = markers.find((m) => m.marker_id === item.markerId);
  return !!marker && marker.status !== 'draft';
};

interface Props {
  projectId: string;
  assets: Asset[];
  markers: Marker[];
  onUploadAssets: (files: File[]) => Promise<Asset[]>;
  items: ReviewItem[];
  source: PlanSource | null;
  droppedCount: number;
  // Set when this plan was restored after its generation was interrupted (crash, reload, quit).
  interrupted: boolean;
  applying: boolean;
  stopping: boolean;
  runState: Record<string, MarkerRunState>;
  onChange: (key: string, patch: Partial<ReviewItem>) => void;
  onRemove: (key: string) => void;
  onDiscard: () => void;
  onApply: () => void;
  onStop: () => void;
  // The item whose area is currently being drawn on the preview above (ALL_AREAS_KEY for all), if any.
  editingRegionKey: string | null;
  onStartEditRegion: (key: string) => void;
  onDoneEditRegion: () => void;
  onResetRegion: () => void;
}

const rowStatus = (item: ReviewItem, markers: Marker[], run?: MarkerRunState): DisplayStatus | null => {
  if (!item.markerId) return null;
  if (run?.phase === 'generating') return 'generating';
  if (run?.phase === 'done') return run.success ? 'ready' : 'error';
  const marker = markers.find((m) => m.marker_id === item.markerId);
  if (marker?.status === 'ready' || marker?.status === 'error') return marker.status;
  return 'draft';
};

const sourceLine = (source: PlanSource): string | null => {
  if (source.kind === 'idea') {
    const voice = source.narration && source.voice ? ` Voiceover read by ${source.voice[0].toUpperCase()}${source.voice.slice(1)}.` : '';
    return `From your idea: "${source.idea}"${voice}`;
  }
  return source.context ? `From the transcript, with your instructions: "${source.context}"` : null;
};

export const MarkerPlanReview: React.FC<Props> = ({
  projectId,
  assets,
  markers,
  onUploadAssets,
  items,
  source,
  droppedCount,
  interrupted,
  applying,
  stopping,
  runState,
  onChange,
  onRemove,
  onDiscard,
  onApply,
  onStop,
  editingRegionKey,
  onStartEditRegion,
  onDoneEditRegion,
  onResetRegion,
}) => {
  // Claude was asked for voiceover lines, so every item gets a field even if its line came back empty.
  const withVoiceover = source?.kind === 'idea' && !!source.narration;
  const pending = items.filter((i) => i.included && !isItemDone(i, markers));
  const doneCount = items.filter((i) => isItemDone(i, markers)).length;
  const editingAll = editingRegionKey === ALL_AREAS_KEY;
  const sourceText = source ? sourceLine(source) : null;

  return (
    <div className="panel">
      <div className="panel-hint">
        {source?.kind === 'idea' ? 'Claude designed these markers from your idea.' : 'Claude read the transcript and proposed these markers.'}{' '}
        Edit or remove any before generating — nothing is created until you apply. The plan is saved, so you can come
        back to it after closing the app.
      </div>
      {sourceText && <div className="panel-hint plan-source">{sourceText}</div>}
      {interrupted && (
        <div className="panel-hint plan-interrupted">
          Generating this plan was interrupted.
          {doneCount > 0 ? ` ${doneCount} marker${doneCount === 1 ? ' was' : 's were'} already made and kept.` : ''} Apply to
          generate the rest.
        </div>
      )}
      {droppedCount > 0 && (
        <div className="panel-hint">
          {droppedCount} proposal{droppedCount === 1 ? ' was' : 's were'} dropped for overlapping an existing marker
          or having an invalid time range/area.
        </div>
      )}
      {items.length > 0 && !applying && (
        <div className="plan-bulk-row">
          {editingAll ? (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Drag on the preview to set one area for all {pending.length} selected marker{pending.length === 1 ? '' : 's'}.
              </span>
              <button type="button" className="btn btn-sm" onClick={onResetRegion}>
                Full screen
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onDoneEditRegion}>
                Done
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending.length === 0 || editingRegionKey !== null}
              onClick={() => onStartEditRegion(ALL_AREAS_KEY)}
              title="Draw one area and use it for every selected marker that has not been generated yet"
            >
              Edit all areas
            </button>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <div className="panel-hint">No new marker opportunities found.</div>
      ) : (
        <div className="plan-review-list">
          {items.map((item) => {
            const run = item.markerId ? runState[item.markerId] : undefined;
            const status = rowStatus(item, markers, run);
            const locked = applying || isItemDone(item, markers);
            return (
              <div key={item.key} className="plan-review-row">
                <div className="plan-review-row-header">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={item.included}
                      disabled={locked}
                      onChange={(e) => onChange(item.key, { included: e.target.checked })}
                    />
                  </label>
                  <div className="capture-row" style={{ flex: 1 }}>
                    <span className="capture-label">Start</span>
                    <input
                      type="number"
                      className="capture-time"
                      value={item.start}
                      disabled={locked}
                      onChange={(e) => onChange(item.key, { start: Number(e.target.value) })}
                    />
                    <span className="capture-label" style={{ marginLeft: 8 }}>
                      End
                    </span>
                    <input
                      type="number"
                      className="capture-time"
                      value={item.end}
                      disabled={locked}
                      onChange={(e) => onChange(item.key, { end: Number(e.target.value) })}
                    />
                  </div>
                  {status && <StatusBadge status={status} />}
                  {!locked && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(item.key)}>
                      Remove
                    </button>
                  )}
                </div>
                <textarea
                  className="field-textarea"
                  value={item.prompt}
                  disabled={locked}
                  onChange={(e) => onChange(item.key, { prompt: e.target.value })}
                />
                {(withVoiceover || item.narration !== undefined) && (
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 4 }}>
                      Voiceover
                      {item.narration?.trim() &&
                        (() => {
                          const spoken = estimateSpeechSeconds(item.narration);
                          const over = spoken > item.end - item.start;
                          return (
                            <span style={{ color: over ? 'var(--mango)' : undefined }}>
                              {' '}
                              · about {spoken.toFixed(1)}s spoken, marker {(item.end - item.start).toFixed(1)}s{over ? ' (too long for the marker)' : ''}
                            </span>
                          );
                        })()}
                    </div>
                    <textarea
                      className="field-textarea"
                      rows={2}
                      value={item.narration ?? ''}
                      disabled={locked}
                      placeholder="No voiceover for this marker"
                      onChange={(e) => onChange(item.key, { narration: e.target.value })}
                    />
                  </div>
                )}
                {(assets.length > 0 || item.assets.length > 0) && (
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 4 }}>
                      Images{item.assets.length > 0 ? ' (suggested by Claude, change if you like)' : ''}
                    </div>
                    <AssetPicker
                      projectId={projectId}
                      assets={assets}
                      selected={item.assets}
                      onChange={(ids) => onChange(item.key, { assets: ids })}
                      onUpload={onUploadAssets}
                      disabled={locked}
                    />
                  </div>
                )}
                <div>
                  {editingRegionKey === item.key ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        Drag on the preview above to draw, move, or resize the area.
                      </span>
                      <button type="button" className="btn btn-sm" onClick={onResetRegion}>
                        Full screen
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={onDoneEditRegion}>
                        Done
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{formatRegion(item.region)}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={locked || (editingRegionKey !== null && editingRegionKey !== item.key)}
                        onClick={() => onStartEditRegion(item.key)}
                      >
                        Edit area
                      </button>
                    </div>
                  )}
                </div>
                {item.error && <div className="field-error">{item.error}</div>}
                {run && run.log.length > 0 && (
                  <div className="run-log">
                    {run.log.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {applying ? (
          <>
            <button type="button" className="btn btn-primary" disabled>
              Generating…
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={stopping}
              onClick={onStop}
              title="Stop Claude now. Markers already made are kept; the one being made is removed, and the rest stay in the plan."
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={pending.length === 0} onClick={onApply}>
              {`Generate ${pending.length} marker${pending.length === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDiscard}>
              {doneCount > 0 ? 'Close plan' : 'Discard plan'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
