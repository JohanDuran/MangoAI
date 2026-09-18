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

export interface RunClaudeCaptureResult extends RunClaudeResult {
  text: string;
}

// Same headless invocation as runClaudeHeadless, but also accumulates Claude's final text
// answer — for callers that want a structured response (e.g. JSON) instead of file edits.
// Follows the documented `claude --print --output-format stream-json` shape: a final
// {"type":"result","result":"<text>"} line, with {"type":"assistant",...} text blocks
// along the way as a fallback if `result` is ever missing.
export async function runClaudeHeadlessCapturingText(opts: RunClaudeOptions): Promise<RunClaudeCaptureResult> {
  let resultText = '';
  let assistantBuffer = '';
  const result = await runClaudeHeadless({
    ...opts,
    onEvent: (event) => {
      opts.onEvent(event);
      const e = event as { type?: string; result?: string; message?: { content?: { type?: string; text?: string }[] } };
      if (e?.type === 'result' && typeof e.result === 'string') {
        resultText = e.result;
      } else if (e?.type === 'assistant') {
        for (const block of e.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') assistantBuffer += block.text;
        }
      }
    },
  });
  return { ...result, text: resultText || assistantBuffer };
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
  regionWidth: number;
  regionHeight: number;
  isFullScreen: boolean;
}): string {
  const file = `03_remotion_code/marker_${opts.markerId}.tsx`;
  const regionSentence = opts.isFullScreen
    ? `Your component receives \`regionWidth\` and \`regionHeight\` props (currently ${opts.regionWidth}x${opts.regionHeight}px, the full canvas) — read your available space from these props, not useVideoConfig()'s width/height, so the layout keeps working if this marker is later confined to a smaller on-screen area. Keep all content within regionWidth/regionHeight (with sensible margins) so nothing renders off-screen.`
    : `This marker has been confined to a rectangle within the video canvas (the full canvas is ${opts.compositionWidth}x${opts.compositionHeight}px, but this marker only owns a ${opts.regionWidth}x${opts.regionHeight}px sub-area of it). Your component receives \`regionWidth\` and \`regionHeight\` props — this is your ENTIRE available space, and (0,0) is the top-left of YOUR rectangle, not the full canvas. Do not read useVideoConfig()'s width/height for layout — use regionWidth/regionHeight instead. Anything positioned beyond regionWidth/regionHeight is clipped and invisible, so scale text, shapes, and any shared primitive's x/y to fit inside this smaller area (percentages of regionWidth/regionHeight work well).`;
  const sections = [
    `Update the overlay component in ${file}.`,
    regionSentence,
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
