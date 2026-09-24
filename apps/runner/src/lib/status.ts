import fs from 'node:fs';
import path from 'node:path';
import { discoverSkills } from './skills.js';
import { LOG_FILE } from './log.js';
import { ffmpegBin, ffprobeBin, findClaude, quoteForCmd } from './bin.js';
import { runCommand } from './proc.js';
import { videoEncoder } from './encoder.js';
import { freeBytes, formatBytes } from './disk.js';
import { NODE_MODULES_DIR, PROJECTS_ROOT } from './paths.js';
import { APP_VERSION } from './version.js';
import { getUsage } from './usage.js';

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

async function run(cmd: string, args: string[], viaShell = false): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const result = viaShell
    ? await runCommand(quoteForCmd(cmd), args.map(quoteForCmd), { timeoutMs: COMMAND_TIMEOUT_MS, shell: true })
    : await runCommand(cmd, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.error) return { ok: false, stdout: result.stdout, error: /ENOENT/.test(result.error) ? 'not found' : result.error.slice(0, 300) };
  if (result.timedOut) return { ok: false, stdout: result.stdout, error: 'did not answer in time' };
  if (result.code !== 0) return { ok: false, stdout: result.stdout, error: (result.stderr.trim() || `exit code ${result.code}`).slice(0, 300) };
  return { ok: true, stdout: result.stdout };
}

const timed = async (fn: () => Promise<Omit<StatusCheck, 'ms'>>): Promise<StatusCheck> => {
  const started = Date.now();
  const check = await fn();
  return { ...check, ms: Date.now() - started };
};

// The oldest CLI known to accept every flag the runner passes. Older ones may still work; this only warns.
const MIN_CLAUDE_VERSION = [2, 0, 0];
const INSTALL_HELP = 'Install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), open a terminal, run `claude` once and sign in.';

const parseVersion = (text: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const isOlder = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

async function checkClaude(): Promise<Omit<StatusCheck, 'ms'>> {
  const base = { id: 'claude', label: 'Claude CLI' };
  const binary = findClaude();
  if (!binary) {
    return { ...base, state: 'error', summary: 'Claude Code CLI not found', details: [INSTALL_HELP, 'Every AI feature (marker design, planning, image descriptions) depends on it.'] };
  }
  const version = await run(binary.command, ['--version'], binary.viaShell);
  if (!version.ok) {
    return { ...base, state: 'error', summary: `Claude CLI does not run: ${version.error}`, details: [binary.command, INSTALL_HELP] };
  }
  const details = [version.stdout.trim(), binary.command];
  const parsed = parseVersion(version.stdout);
  const outdated = parsed !== null && isOlder(parsed, MIN_CLAUDE_VERSION);
  if (outdated) details.push('This version is older than MangoAI supports. Update it with `claude update`.');

  const auth = await run(binary.command, ['auth', 'status'], binary.viaShell);
  if (!auth.ok) {
    // Older CLIs have no `auth status`; the binary works, but sign-in state is unknown.
    return { ...base, state: 'warn', summary: outdated ? 'Installed, but outdated' : 'Installed, sign-in state unknown', details: [...details, 'Could not read `claude auth status`. Run `claude` once to make sure you are signed in.'] };
  }
  try {
    const status = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (!status.loggedIn) return { ...base, state: 'error', summary: 'Installed but not signed in', details: [...details, 'Run `claude` in a terminal and sign in.'] };
    const via = [status.authMethod, status.subscriptionType].filter(Boolean).join(' · ');
    return { ...base, state: outdated ? 'warn' : 'ok', summary: `${via ? `Signed in (${via})` : 'Signed in'}${outdated ? ', but outdated' : ''}`, details };
  } catch {
    return { ...base, state: 'warn', summary: 'Installed, could not read sign-in state', details };
  }
}

async function checkFfmpeg(): Promise<Omit<StatusCheck, 'ms'>> {
  const [ffmpeg, ffprobe] = await Promise.all([run(ffmpegBin(), ['-version']), run(ffprobeBin(), ['-version'])]);
  const missing = [!ffmpeg.ok && 'ffmpeg', !ffprobe.ok && 'ffprobe'].filter(Boolean);
  const base = { id: 'ffmpeg', label: 'ffmpeg / ffprobe' };
  if (missing.length > 0) {
    return { ...base, state: 'error', summary: `${missing.join(' and ')} not found`, details: ['Needed for video upload, audio extraction, transcription and export.', 'Install ffmpeg 4.4 or newer and make sure it is on your PATH.'] };
  }
  const first = (out: string) => out.split(/\r?\n/)[0]?.replace(/ Copyright.*$/, '') ?? '';
  return { ...base, state: 'ok', summary: 'Both available', details: [first(ffmpeg.stdout), first(ffprobe.stdout)] };
}

async function checkEncoder(): Promise<Omit<StatusCheck, 'ms'>> {
  const base = { id: 'encoder', label: 'Video encoder' };
  const encoder = await videoEncoder();
  return encoder.gpu
    ? { ...base, state: 'ok', summary: encoder.label, details: ['Final MP4 exports are encoded on the graphics card.'] }
    : { ...base, state: 'ok', summary: encoder.label, details: ['No usable NVIDIA encoder found, so MP4 exports are encoded on the CPU. They work, just slower.'] };
}

function checkDisk(): Omit<StatusCheck, 'ms'> {
  const base = { id: 'disk', label: 'Disk space' };
  const free = freeBytes(PROJECTS_ROOT);
  if (free === null) return { ...base, state: 'warn', summary: 'Could not read free space', details: [PROJECTS_ROOT] };
  const GB = 1024 ** 3;
  const details = [`Projects folder: ${PROJECTS_ROOT}`, 'Exports of long videos can need several GB.'];
  if (free < 1 * GB) return { ...base, state: 'error', summary: `${formatBytes(free)} free`, details };
  if (free < 5 * GB) return { ...base, state: 'warn', summary: `${formatBytes(free)} free`, details };
  return { ...base, state: 'ok', summary: `${formatBytes(free)} free`, details };
}

function checkRenderer(): Omit<StatusCheck, 'ms'> {
  const base = { id: 'renderer', label: 'Export renderer' };
  const shell = path.join(NODE_MODULES_DIR, '.remotion', 'chrome-headless-shell');
  if (process.env.MANGO_CHROME_PATH ? fs.existsSync(process.env.MANGO_CHROME_PATH) : fs.existsSync(shell)) {
    return { ...base, state: 'ok', summary: 'Chrome Headless Shell installed', details: [] };
  }
  return { ...base, state: 'warn', summary: 'Downloads on first export', details: ['Remotion fetches its own browser (about 110 MB) the first time you export, so that export needs an internet connection.'] };
}

// Listing models is a free authenticated call, so it proves the key works without spending anything.
async function checkOpenAI(): Promise<Omit<StatusCheck, 'ms'>> {
  const base = { id: 'openai', label: 'OpenAI' };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...base, state: 'warn', summary: 'OPENAI_API_KEY is not set', details: ['Transcription and image generation are unavailable. Add your OpenAI API key below (desktop app) or to apps/runner/.env and restart the runner.'] };
  }
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS) });
    if (res.ok) return { ...base, state: 'ok', summary: 'Key accepted', details: [`Endpoint: ${baseUrl}`] };
    if (res.status === 401 || res.status === 403) return { ...base, state: 'error', summary: `Key rejected (${res.status})`, details: ['Enter the key again below (desktop app) or check apps/runner/.env.'] };
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
  const usage = getUsage();

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
    {
      id: 'runner',
      label: 'Runner',
      state: 'ok' as const,
      summary: `MangoAI ${APP_VERSION}, port ${process.env.PORT || 5175}`,
      details: [`Node ${process.version}`, `Up ${Math.round(process.uptime())}s`, `Claude this session: ${usage.runs} runs, about $${usage.costUsd.toFixed(2)} (metered value; subscription plans are not billed per run)`],
    },
    ...(await Promise.all([timed(checkClaude), timed(checkOpenAI), timed(checkFfmpeg), timed(checkEncoder)])),
    checkRenderer(),
    checkDisk(),
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
