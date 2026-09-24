import React, { useState } from 'react';

interface Props {
  planning: boolean;
  error: string | null;
  onSubmit: (idea: string) => void;
  onCancel: () => void;
}

export const IdeaPlanPanel: React.FC<Props> = ({ planning, error, onSubmit, onCancel }) => {
  const [idea, setIdea] = useState('');
  const canSubmit = idea.trim().length > 0 && !planning;

  return (
    <div className="panel">
      <div className="panel-hint">
        Describe what the video should cover. Claude will design a full sequence of correlated markers spanning the
        whole duration, not just one.
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
          onChange={(e) => setIdea(e.target.value)}
          disabled={planning}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {planning ? 'Designing…' : 'Design markers'}
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
