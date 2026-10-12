import React from 'react';
import type { Asset, Consistency, Marker, PlanDesign, PlanItem, PlanSource } from '../api/client';
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
  // Proposals retimed to play one after another instead of overlapping (and, on an uploaded video,
  // to fit inside it).
  movedCount: number;
  // Whether the project is built on an uploaded video, whose length is fixed.
  videoLocked: boolean;
  // How alike the markers are built, the look they share, and a series' shared template.
  design: PlanDesign;
  onDesignChange: (design: PlanDesign) => void;
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

const CONSISTENCY_LABELS: Record<Consistency, string> = {
  series: 'One template for all',
  themed: 'Same look',
  varied: 'Each its own design',
};

const CONSISTENCY_HINTS: Record<Consistency, string> = {
  series:
    'The repeated markers all render one template, built once with the first of them, so they look identical apart from their content. Markers without template content are built in the same look.',
  themed: 'The first marker is built first, and every other marker is built to match its design.',
  varied: 'Every marker is designed on its own; only the shared look below ties them together.',
};

// Whether a marker's template content is a JSON object (or empty, for a marker outside the template).
const propsError = (text: string | undefined): string | null => {
  if (!text?.trim()) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? null : 'Must be a JSON object.';
  } catch {
    return 'Not valid JSON; this marker would be skipped.';
  }
};

const sourceLine = (source: PlanSource): string | null => {
  if (source.kind === 'idea') {
    const voice = source.narration && source.voice ? ` Voiceover read by ${source.voice[0].toUpperCase()}${source.voice.slice(1)}.` : '';
    const idea = source.idea.length > 200 ? `${source.idea.slice(0, 200).trimEnd()}…` : source.idea;
    return `From your idea: "${idea}"${voice}`;
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
  movedCount,
  videoLocked,
  design,
  onDesignChange,
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
  // Claude could tick AI image generation, so every item shows that choice.
  const withImages = source?.kind === 'idea' && !!source.images;
  const pending = items.filter((i) => i.included && !isItemDone(i, markers));
  const doneCount = items.filter((i) => isItemDone(i, markers)).length;
  const editingAll = editingRegionKey === ALL_AREAS_KEY;
  const sourceText = source ? sourceLine(source) : null;
  const look = design.look;
  // The template only exists when the plan was made as a series; switching away keeps it for coming back.
  const asSeries = design.consistency === 'series' && !!design.component;
  const choices: Consistency[] = design.component ? ['series', 'themed', 'varied'] : ['themed', 'varied'];
  // A series plan without a template (one could not be planned) is built as themed.
  const shown: Consistency = asSeries ? 'series' : design.consistency === 'series' ? 'themed' : design.consistency;

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
          {droppedCount} proposal{droppedCount === 1 ? ' was' : 's were'} left out because Claude gave no description or
          times for {droppedCount === 1 ? 'it' : 'them'}.
        </div>
      )}
      {movedCount > 0 && (
        <div className="panel-hint">
          {movedCount} marker{movedCount === 1 ? ' was' : 's were'} retimed so they play one after another instead of
          overlapping{' '}
          {source?.kind === 'transcript' || videoLocked ? 'and fit inside the video' : '(the canvas gets longer to hold them)'}.
          Remove any you don't want.
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span className="capture-label">Markers</span>
          <select
            className="field-select"
            style={{ width: 'auto', padding: '5px 8px' }}
            value={shown}
            disabled={applying}
            onChange={(e) => onDesignChange({ ...design, consistency: e.target.value as Consistency })}
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {CONSISTENCY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{CONSISTENCY_HINTS[shown]}</div>
      </div>
      {asSeries && design.component && (
        <div style={{ marginBottom: 12 }}>
          <span className="capture-label" style={{ display: 'block', marginBottom: 4 }}>
            Template: {design.component.name}
          </span>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 4 }}>
            What the shared template shows and the content it takes. Each repeated marker fills it in below.
          </div>
          <textarea
            className="field-textarea"
            rows={4}
            value={design.component.spec}
            disabled={applying}
            onChange={(e) => onDesignChange({ ...design, component: { ...design.component!, spec: e.target.value } })}
          />
        </div>
      )}
      {(look || !applying) && (
        <div style={{ marginBottom: 12 }}>
          <span className="capture-label" style={{ display: 'block', marginBottom: 4 }}>
            Shared look
          </span>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 4 }}>
            Every marker of this plan is built to this style, so the video looks consistent. A style preset on a marker wins
            over it.
          </div>
          <textarea
            className="field-textarea"
            rows={3}
            value={look}
            disabled={applying}
            placeholder="No shared look: each marker is styled on its own"
            onChange={(e) => onDesignChange({ ...design, look: e.target.value })}
          />
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
                {asSeries && (
                  <div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 4 }}>
                      Template content (JSON){item.props?.trim() ? '' : ' · empty: built on its own in the same look'}
                    </div>
                    <textarea
                      className="field-textarea"
                      rows={Math.min(8, Math.max(2, (item.props ?? '').split('\n').length))}
                      style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                      value={item.props ?? ''}
                      disabled={locked}
                      placeholder="Not part of the template"
                      onChange={(e) => onChange(item.key, { props: e.target.value })}
                    />
                    {propsError(item.props) && <div className="field-error">{propsError(item.props)}</div>}
                  </div>
                )}
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
                {(withImages || item.allowImage) && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={item.allowImage}
                      disabled={locked}
                      onChange={(e) => onChange(item.key, { allowImage: e.target.checked })}
                    />
                    Allow AI image generation{item.allowImage && withImages ? ' (Claude thinks this marker needs an image)' : ''}
                  </label>
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
