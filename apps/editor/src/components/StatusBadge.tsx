import React from 'react';
import type { DisplayStatus } from '../status';

const LABELS: Record<DisplayStatus, string> = {
  draft: 'draft',
  generating: 'generating',
  ready: 'ready',
  error: 'error',
};

export const StatusBadge: React.FC<{ status: DisplayStatus }> = ({ status }) => (
  <span className={`badge status-${status}`}>
    <span className="badge-dot" />
    {LABELS[status]}
  </span>
);
