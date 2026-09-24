import React, { useCallback, useEffect, useState } from 'react';
import { getStatus, type CheckState, type StatusReport } from '../api/client';

const STALE_MS = 60_000;

// Kept outside React so the dot survives Workspace remounting on every project switch
// without hitting OpenAI again each time.
let cached: { report: StatusReport | null; error: string | null; at: number } = { report: null, error: null, at: 0 };

const OVERALL_LABEL: Record<CheckState, string> = {
  ok: 'All systems ready',
  warn: 'Some features unavailable',
  error: 'Something needs attention',
};

export function useStatus() {
  const [report, setReport] = useState<StatusReport | null>(cached.report);
  const [error, setError] = useState<string | null>(cached.error);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getStatus();
      cached = { report: next, error: null, at: Date.now() };
    } catch (err) {
      // No response at all means the runner itself is down.
      cached = { report: null, error: err instanceof Error ? err.message : String(err), at: Date.now() };
    }
    setReport(cached.report);
    setError(cached.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (Date.now() - cached.at > STALE_MS) void refresh();
  }, [refresh]);

  const state: CheckState | 'loading' = report ? report.overall : error ? 'error' : 'loading';
  return { report, error, loading, state, refresh };
}

export const StatusButton: React.FC<{ state: CheckState | 'loading'; onClick: () => void }> = ({ state, onClick }) => (
  <button type="button" className="btn btn-sm status-btn" onClick={onClick} title="Status of the runner, Claude CLI, OpenAI and skills">
    <span className={`status-dot ${state}`} />
    Status
  </button>
);

interface Props {
  report: StatusReport | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export const StatusDashboard: React.FC<Props> = ({ report, error, loading, onRefresh, onClose }) => {
  useEffect(() => {
    // Opening the dashboard always re-checks; the cached report is just what shows first.
    onRefresh();
  }, [onRefresh]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Status">
        <div className="modal-header">
          <h2 style={{ margin: 0, fontSize: 18 }}>Status</h2>
          {report && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{OVERALL_LABEL[report.overall]}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={loading}>
            {loading ? 'Checking…' : 'Re-check'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {error && !report && (
          <div className="status-card">
            <div className="status-card-head">
              <span className="status-dot error" />
              Runner
            </div>
            <div className="status-summary">Can't reach the runner.</div>
            <ul className="status-details">
              <li>Start it from apps/runner, then re-check.</li>
              <li>{error}</li>
            </ul>
          </div>
        )}

        {report && (
          <>
            <div className="status-grid">
              {report.checks.map((c) => (
                <div key={c.id} className="status-card">
                  <div className="status-card-head">
                    <span className={`status-dot ${c.state}`} />
                    {c.label}
                    {c.ms !== undefined && c.ms >= 50 && <span className="status-ms">{c.ms} ms</span>}
                  </div>
                  <div className="status-summary">{c.summary}</div>
                  {c.details && c.details.length > 0 && (
                    <ul className="status-details">
                      {c.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            <h3 className="status-section-title">Skills</h3>
            {report.skills.map((s) => (
              <div key={s.name} className="status-skill">
                <span className={`status-dot ${s.missingEnv.length > 0 ? 'warn' : 'ok'}`} style={{ marginTop: 6 }} />
                <div>
                  <div className="status-skill-name">
                    {s.name}
                    {s.origin === 'external' && <span className="status-tag">external</span>}
                    {s.optIn && <span className="status-tag">opt-in</span>}
                    {s.hasTools && <span className="status-tag">tools</span>}
                  </div>
                  <div className="status-skill-desc">
                    {s.missingEnv.length > 0 ? `Missing ${s.missingEnv.join(', ')} — skipped until set. ` : ''}
                    {s.description}
                  </div>
                </div>
              </div>
            ))}
            {report.skillProblems.map((p) => (
              <div key={p.folder} className="status-skill">
                <span className="status-dot error" style={{ marginTop: 6 }} />
                <div>
                  <div className="status-skill-name">{p.folder}</div>
                  <div className="status-skill-desc">{p.error}</div>
                </div>
              </div>
            ))}
            <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-faint)' }}>
              Checked {new Date(report.checkedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
