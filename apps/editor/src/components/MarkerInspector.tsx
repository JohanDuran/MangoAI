import React, { useEffect, useState } from 'react';
import { getMarkerCode, type Marker, type TranscriptSegment } from '../api/client';
import type { MarkerRunState } from '../App';
import { displayStatus } from '../status';
import { StatusBadge } from './StatusBadge';

interface Props {
  projectId: string;
  marker: Marker | null;
  run?: MarkerRunState;
  transcript: TranscriptSegment[];
  onRegenerate: (markerId: string, feedback: string, allowImage: boolean) => void;
}

export const MarkerInspector: React.FC<Props> = ({ projectId, marker, run, transcript, onRegenerate }) => {
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [allowImage, setAllowImage] = useState(false);

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
    return <div className="inspector-empty">Select a marker on the timeline to see its status, or add one below the video.</div>;
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

      <label className="field-label">{marker.status === 'draft' ? 'Prompt' : 'Feedback for the next attempt'}</label>
      <textarea
        className="field-textarea"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="e.g. 'make the entrance faster and use a dark navy background'"
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)', margin: '8px 0' }}>
        <input type="checkbox" checked={allowImage} onChange={(e) => setAllowImage(e.target.checked)} />
        Needs a generated image (generates one via OpenAI before writing the code)
      </label>
      <button
        onClick={() => onRegenerate(marker.marker_id, feedback, allowImage)}
        disabled={generating}
        className="btn btn-primary"
      >
        {generating ? 'Generating…' : marker.status === 'draft' ? 'Generate' : 'Regenerate'}
      </button>

      <div className="code-toggle">
        <button onClick={() => setShowCode((v) => !v)} className="btn btn-ghost btn-sm">
          {showCode ? 'Hide code' : 'View code'}
        </button>
        {showCode && <pre className="code-view">{code}</pre>}
      </div>
    </div>
  );
};
