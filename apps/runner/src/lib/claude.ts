import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

// Only one headless Claude run may be in flight per project — a new regenerate request
// supersedes whatever is currently writing to the same marker file.
export function killActive(projectId: string): void {
  const child = activeProcesses.get(projectId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
  activeProcesses.delete(projectId);
}

export interface RunClaudeOptions {
  projectId: string;
  cwd: string;
  prompt: string;
  allowedTools: string[];
  onEvent: (event: unknown) => void;
}

export interface RunClaudeResult {
  success: boolean;
  exitCode: number | null;
}

export function runClaudeHeadless(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  killActive(opts.projectId);

  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--print',
        opts.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        opts.allowedTools.join(','),
        '--permission-mode',
        'acceptEdits',
      ],
      // Do NOT set shell: true here — claude resolves to a real .exe (confirmed via
      // `Get-Command claude`), and routing through cmd.exe on Windows silently mangles
      // multi-line prompt arguments (backticks, quotes) instead of passing them verbatim
      // the way spawn()'s argv array does by default.
      { cwd: opts.cwd }
    );

    activeProcesses.set(opts.projectId, child);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        opts.onEvent(JSON.parse(line));
      } catch {
        opts.onEvent({ type: 'raw', line });
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      activeProcesses.delete(opts.projectId);
      if (code !== 0 && stderr) opts.onEvent({ type: 'stderr', message: stderr });
      resolve({ success: code === 0, exitCode: code });
    });

    child.on('error', (err) => {
      activeProcesses.delete(opts.projectId);
      opts.onEvent({ type: 'spawn-error', message: err.message });
      resolve({ success: false, exitCode: null });
    });
  });
}

export function buildRegeneratePrompt(opts: {
  markerId: string;
  currentCode: string;
  prompt: string;
  feedback: string;
  priorError?: string;
  transcript?: string;
  imageUrl?: string;
  compositionWidth: number;
  compositionHeight: number;
}): string {
  const file = `03_remotion_code/marker_${opts.markerId}.tsx`;
  const sections = [
    `Update the overlay component in ${file}.`,
    `The video canvas for this project is ${opts.compositionWidth}x${opts.compositionHeight}px — read it via ` +
      `useVideoConfig() rather than hardcoding a different size, and keep all content within those bounds ` +
      `(with sensible margins) so nothing renders off-screen. If you use a shared primitive's default x/y, check ` +
      `it still lands on-screen at this canvas size and pass explicit x/y if not.`,
    `Original creative intent: ${opts.prompt}`,
    opts.feedback ? `Latest feedback: ${opts.feedback}` : null,
    opts.transcript ? `What's being said in the video during this marker's time range: "${opts.transcript}"` : null,
    opts.imageUrl
      ? `An image has already been generated for this marker and is served at: ${opts.imageUrl}\nUse it directly, e.g. \`<img src="${opts.imageUrl}" />\` or via the ImagePopup primitive's src prop. You cannot generate images yourself — this URL is the only one available for this call.`
      : null,
    `Current code:\n\`\`\`tsx\n${opts.currentCode}\n\`\`\``,
    opts.priorError
      ? `Validation error from the previous attempt — fix this specifically:\n${opts.priorError}`
      : null,
    'Follow the conventions in CLAUDE.md. Only modify this one file.',
  ].filter((s): s is string => Boolean(s));
  return sections.join('\n\n');
}
