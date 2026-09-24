import React, { useState } from 'react';

interface Props {
  planning: boolean;
  error: string | null;
  onSubmit: (context: string) => void;
  onCancel: () => void;
}

// A lightweight step in front of the transcript-based planner: it always uses the
// transcript, but lets the creator steer it with free-text instructions first (e.g. "this
// covers compound interest over 40 years — build a line graph, not just callouts").
export const PlanMarkersPanel: React.FC<Props> = ({ planning, error, onSubmit, onCancel }) => {
  const [context, setContext] = useState('');

  return (
    <div className="panel">
      <div className="panel-hint">
        Claude will propose markers from the transcript. Optionally add instructions to steer what it builds — leave it
        blank to let it decide on its own.
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (planning) return;
          onSubmit(context);
        }}
        className="add-marker-row"
      >
        <textarea
          className="field-textarea"
          rows={6}
          placeholder={
            'e.g. "The section around 0:40-1:20 explains compound interest over 40 years — build a line graph showing the balance growing over time, not just text callouts."'
          }
          value={context}
          onChange={(e) => setContext(e.target.value)}
          disabled={planning}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={planning}>
            {planning ? 'Planning…' : 'Plan markers'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={planning}>
            Cancel
          </button>
        </div>
      </form>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};
