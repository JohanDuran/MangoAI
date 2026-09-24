import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { discoverSkills } from './skills.js';
import { LOG_FILE } from './log.js';

export type CheckState = 'ok' | 'warn' | 'error';

export interface StatusCheck {
  id: string;
  label: string;
  state: CheckState;
  summary: string;
  // Extra lines shown under the summary (versions, what to do next).
  details?: string[];
  ms?: number;
}

export interface StatusSkill {
  name: string;
  origin: 'builtin' | 'external';
  description: string;
  optIn: boolean;
  hasTools: boolean;
  env: string[];
  missingEnv: string[];
}

export interface StatusReport {
  checkedAt: string;
  overall: CheckState;
  checks: StatusCheck[];
  skills: StatusSkill[];
  skillProblems: { folder: string; error: string }[];
}

const COMMAND_TIMEOUT_MS = 8000;
const OPENAI_TIMEOUT_MS = 6000;

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({ ok: false, stdout: String(stdout), error: notFound ? 'not found on PATH' : (String(stderr).trim() || err.message).slice(0, 300) });
      } else {
        resolve({ ok: true, stdout: String(stdout) });
      }
    });
  });
}

const timed = async (fn: () => Promise<Omit<StatusCheck, 'ms'>>): Promise<StatusCheck> => {
  const started = Date.now();
  const check = await fn();
  return { ...check, ms: Date.now() - started };
};

async function checkClaude(): Promise<Omit<StatusCheck, 'ms'>> {
  const base = { id: 'claude', label: 'Claude CLI' };
  const version = await run('claude', ['--version']);
  if (!version.ok) {
    return { ...base, state: 'error', summary: `Claude CLI ${version.error}`, details: ['Install Claude Code and make sure `claude` runs in a terminal. Every AI feature depends on it.'] };
  }
  const details = [version.stdout.trim()];
  const auth = await run('claude', ['auth', 'status']);
  if (!auth.ok) {
    // Older CLIs have no `auth status`; the binary works, but sign-in state is unknown.
    return { ...base, state: 'warn', summary: 'Installed, sign-in state unknown', details: [...details, 'Could not read `claude auth status`. Run `claude` once to make sure you are signed in.'] };
  }
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (!parsed.loggedIn) return { ...base, state: 'error', summary: 'Installed but not signed in', details: [...details, 'Run `claude` in a terminal and sign in.'] };
    const via = [parsed.authMethod, parsed.subscriptionType].filter(Boolean).join(' · ');
    return { ...base, state: 'ok', summary: via ? `Signed in (${via})` : 'Signed in', details };
  } catch {
    return { ...base, state: 'warn', summary: 'Installed, could not read sign-in state', details };
  }
}

async function checkFfmpeg(): Promise<Omit<StatusCheck, 'ms'>> {
  const [ffmpeg, ffprobe] = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  const missing = [!ffmpeg.ok && 'ffmpeg', !ffprobe.ok && 'ffprobe'].filter(Boolean);
  const base = { id: 'ffmpeg', label: 'ffmpeg / ffprobe' };
  if (missing.length > 0) {
    return { ...base, state: 'error', summary: `${missing.join(' and ')} not found on PATH`, details: ['Needed for video upload, audio extraction, transcription and export.'] };
  }
  const first = (out: string) => out.split(/\r?\n/)[0]?.replace(/ Copyright.*$/, '') ?? '';
  return { ...base, state: 'ok', summary: 'Both available', details: [first(ffmpeg.stdout), first(ffprobe.stdout)] };
}

// Listing models is a free authenticated call, so it proves the key works without spending anything.
async function checkOpenAI(): Promise<Omit<StatusCheck, 'ms'>> {
  const base = { id: 'openai', label: 'OpenAI' };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...base, state: 'warn', summary: 'OPENAI_API_KEY is not set', details: ['Transcription and image generation are unavailable. Add the key to apps/runner/.env and restart the runner.'] };
  }
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS) });
    if (res.ok) return { ...base, state: 'ok', summary: 'Key accepted', details: [`Endpoint: ${baseUrl}`] };
    if (res.status === 401 || res.status === 403) return { ...base, state: 'error', summary: `Key rejected (${res.status})`, details: ['Check OPENAI_API_KEY in apps/runner/.env.'] };
    return { ...base, state: 'warn', summary: `Unexpected response (${res.status})`, details: [`Endpoint: ${baseUrl}`] };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ...base, state: 'error', summary: timedOut ? 'No response (timed out)' : 'Could not reach OpenAI', details: [`Endpoint: ${baseUrl}`, ...(timedOut || !(err instanceof Error) ? [] : [err.message])] };
  }
}

function checkLog(): Omit<StatusCheck, 'ms'> {
  const base = { id: 'log', label: 'Runner log' };
  try {
    const size = fs.statSync(LOG_FILE).size;
    return { ...base, state: 'ok', summary: `${(size / 1024).toFixed(0)} KB`, details: [LOG_FILE] };
  } catch {
    return { ...base, state: 'warn', summary: 'No log file yet', details: [LOG_FILE] };
  }
}

export async function collectStatus(): Promise<StatusReport> {
  const { skills, problems } = discoverSkills();

  const skillsWithMissing = skills.filter((s) => s.missingEnv.length > 0);
  const skillsCheck: StatusCheck = {
    id: 'skills',
    label: 'Skills',
    state: problems.length > 0 ? 'error' : skillsWithMissing.length > 0 ? 'warn' : 'ok',
    summary:
      problems.length > 0
        ? `${problems.length} skill${problems.length === 1 ? '' : 's'} failed to load`
        : skillsWithMissing.length > 0
        ? `${skills.length - skillsWithMissing.length} of ${skills.length} ready`
        : `${skills.length} loaded, all ready`,
    details: skillsWithMissing.map((s) => `${s.name} is missing ${s.missingEnv.join(', ')}`),
  };

  const checks = [
    { id: 'runner', label: 'Runner', state: 'ok' as const, summary: `Listening on port ${process.env.PORT || 5175}`, details: [`Node ${process.version}`, `Up ${Math.round(process.uptime())}s`] },
    ...(await Promise.all([timed(checkClaude), timed(checkOpenAI), timed(checkFfmpeg)])),
    skillsCheck,
    checkLog(),
  ];

  const rank: Record<CheckState, number> = { ok: 0, warn: 1, error: 2 };
  const overall = checks.reduce<CheckState>((worst, c) => (rank[c.state] > rank[worst] ? c.state : worst), 'ok');

  return {
    checkedAt: new Date().toISOString(),
    overall,
    checks,
    skills: skills.map((s) => ({
      name: s.name,
      origin: s.origin,
      description: s.description,
      optIn: s.manifest.optIn ?? false,
      hasTools: !!s.manifest.mcp,
      env: s.manifest.env ?? [],
      missingEnv: s.missingEnv,
    })),
    skillProblems: problems,
  };
}
