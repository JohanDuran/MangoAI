import React, { useCallback, useEffect, useState } from 'react';
import { getStatus, type CheckState, type StatusReport } from '../api/client';
import { desktop, type DesktopInfo } from '../desktop';
import { notify } from '../notify';

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


const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

// Only shown inside the desktop app: the settings and shortcuts that need the operating system.
const DesktopSettings: React.FC<{ report: StatusReport | null; onChanged: () => void }> = ({ report, onChanged }) => {
  const api = desktop();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void api?.info().then(setInfo);
  }, [api, report]);

  if (!api) return null;
  const claude = report?.checks.find((c) => c.id === 'claude');
  const openai = report?.checks.find((c) => c.id === 'openai');

  const saveKey = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.setOpenAIKey(key);
      if (result.ok) {
        setKey('');
        setMessage({ ok: true, text: result.validated ? 'Key saved and accepted by OpenAI.' : 'Key saved. OpenAI could not be reached to check it right now.' });
        onChanged();
      } else {
        setMessage({ ok: false, text: result.error ?? 'The key was not saved.' });
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    await api.clearOpenAIKey();
    setMessage({ ok: true, text: 'Key removed.' });
    onChanged();
  };

  const saveDiagnostics = async () => {
    const result = await api.exportDiagnostics();
    if (result.saved) notify('info', `Diagnostics saved to ${result.file}`);
  };

  return (
    <>
      {claude && claude.state !== 'ok' && (
        <div className="desktop-card">
          <h3>Set up Claude Code</h3>
          <div className="desktop-hint">
            MangoAI designs animations with the Claude Code CLI, which you install and sign in to yourself. Install it, open a terminal, run <b>claude</b> once and sign in, then press Re-check.
          </div>
          <div className="desktop-row">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void api.openExternal(CLAUDE_INSTALL_URL)}>
              Open installation instructions
            </button>
          </div>
        </div>
      )}

      <div className="desktop-card">
        <h3>OpenAI API key {openai && <span className={`status-dot ${openai.state}`} style={{ marginLeft: 6 }} />}</h3>
        <div className="desktop-hint">
          Used for transcribing your video (Whisper) and for optional AI image generation. {info?.hasOpenAIKey ? 'A key is stored on this PC.' : 'No key stored yet.'} It is saved encrypted for your Windows account and never written to a project or log file.
        </div>
        <div className="desktop-row">
          <input
            type="password"
            className="field-input"
            placeholder={info?.hasOpenAIKey ? 'Paste a new key to replace the stored one' : 'sk-...'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={saveKey} disabled={busy || key.trim().length < 8}>
            {busy ? 'Checking…' : 'Save key'}
          </button>
          {info?.hasOpenAIKey && (
            <button type="button" className="btn btn-sm" onClick={removeKey} disabled={busy}>
              Remove
            </button>
          )}
        </div>
        {info && !info.secureStorage && <div className="desktop-hint" style={{ color: 'var(--error)' }}>Secure storage is not available on this system, so a key cannot be saved.</div>}
        {message && <div className="desktop-hint" style={{ color: message.ok ? 'var(--ready)' : 'var(--error)' }}>{message.text}</div>}
      </div>

      <div className="desktop-card">
        <h3>Help and files</h3>
        <div className="desktop-hint">
          MangoAI {info?.version ?? ''}. Projects: {info?.projectsDir ?? '…'}
        </div>
        <div className="desktop-row">
          <button type="button" className="btn btn-sm" onClick={() => void api.openFolder('projects')}>
            Open projects folder
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void api.openFolder('logs')}>
            Open log folder
          </button>
          <button type="button" className="btn btn-sm" onClick={saveDiagnostics} title="A text file with versions, status and the recent log, safe to send when reporting a problem">
            Save diagnostics file
          </button>
        </div>
      </div>
    </>
  );
};

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
              <li>{desktop() ? 'The MangoAI engine is not responding. Close and reopen MangoAI, and use Help → Save diagnostics if it keeps happening.' : 'Start it from apps/runner, then re-check.'}</li>
              <li>{error}</li>
            </ul>
          </div>
        )}

        <DesktopSettings report={report} onChanged={onRefresh} />

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
