import React from 'react';
import type { Asset, MarkerRegion } from '../api/client';
import { AssetPicker } from './AssetPicker';
import type { MarkerRunState } from '../App';
import type { DisplayStatus } from '../status';
import { StatusBadge } from './StatusBadge';
import { formatRegion } from '../format';

export interface ReviewItem {
  key: string;
  included: boolean;
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
  // Ids of library images attached to this proposed marker.
  assets: string[];
  markerId?: string;
  // Set when the server rejected this item before it could even be created (e.g. an
  // edited time range now overlaps another marker) — distinct from a generation failure,
  // which is tracked via runState once the marker exists.
  error?: string;
}

interface Props {
  projectId: string;
  assets: Asset[];
  onUploadAssets: (files: File[]) => Promise<Asset[]>;
  items: ReviewItem[];
  droppedCount: number;
  applying: boolean;
  runState: Record<string, MarkerRunState>;
  onChange: (key: string, patch: Partial<ReviewItem>) => void;
  onRemove: (key: string) => void;
  onCancel: () => void;
  onApply: () => void;
}

const rowStatus = (item: ReviewItem, run?: MarkerRunState): DisplayStatus | null => {
  if (!item.markerId) return null;
  if (run?.phase === 'generating') return 'generating';
  if (run?.phase === 'done') return run.success ? 'ready' : 'error';
  return 'draft';
};

export const MarkerPlanReview: React.FC<Props> = ({
  projectId,
  assets,
  onUploadAssets,
  items,
  droppedCount,
  applying,
  runState,
  onChange,
  onRemove,
  onCancel,
  onApply,
}) => {
  const includedCount = items.filter((i) => i.included).length;

  return (
    <div className="panel">
      <div className="panel-hint">
        Claude read the transcript and proposed these markers. Edit or remove any before generating — nothing is
        created until you apply.
      </div>
      {droppedCount > 0 && (
        <div className="panel-hint">
          {droppedCount} proposal{droppedCount === 1 ? ' was' : 's were'} dropped for overlapping an existing marker
          or having an invalid time range/area.
        </div>
      )}
      {items.length === 0 ? (
        <div className="panel-hint">No new marker opportunities found.</div>
      ) : (
        <div className="plan-review-list">
          {items.map((item) => {
            const run = item.markerId ? runState[item.markerId] : undefined;
            const status = rowStatus(item, run);
            const locked = applying;
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
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{formatRegion(item.region)}</div>
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
        <button type="button" className="btn btn-primary" disabled={applying || includedCount === 0} onClick={onApply}>
          {applying ? 'Generating…' : `Generate ${includedCount} marker${includedCount === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="btn btn-ghost" disabled={applying} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
};
