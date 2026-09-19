import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Claude runs for one project are executed one at a time. A second request waits for the first
// instead of killing it: two generations for different markers used to kill each other's
// process, and two runs can never race on the same project files.
const queues = new Map<string, Promise<void>>();

export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(projectId, tail);
  void tail.then(() => {
    if (queues.get(projectId) === tail) queues.delete(projectId);
  });
  return run;
}

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  // Built-in tools available to Claude (--tools). Empty means no tools at all.
  tools: string[];
  // Pre-approved tools (--allowedTools). Use this for MCP tools only: a bare built-in name
  // such as "Read" here grants access to every path on the machine, while a built-in that is
  // merely available through `tools` stays confined to the project directory.
  allowedTools?: string[];
  mcpConfigPath?: string;
  // Environment variables to hide from the claude process (secrets of inactive skills).
  envExclude?: string[];
  onEvent: (event: unknown) => void;
}

export interface RunClaudeResult {
  success: boolean;
  exitCode: number | null;
}

export function runClaudeHeadless(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const env = { ...process.env };
  for (const key of opts.envExclude ?? []) delete env[key];

  return new Promise((resolve) => {
    const args = [
      '--print',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      opts.tools.join(','),
    ];
    if (opts.allowedTools && opts.allowedTools.length > 0) args.push('--allowedTools', opts.allowedTools.join(','));
    if (opts.mcpConfigPath) args.push('--mcp-config', opts.mcpConfigPath);
    // Keep runs identical across machines: ignore the user's global MCP connectors and
    // user-level skills/plugins/settings.
    args.push('--strict-mcp-config', '--setting-sources', 'project', '--permission-mode', 'acceptEdits');

    const child = spawn(
      'claude',
      args,
      // Do NOT set shell: true here — claude resolves to a real .exe (confirmed via
      // `Get-Command claude`), and routing through cmd.exe on Windows silently mangles
      // multi-line prompt arguments (backticks, quotes) instead of passing them verbatim
      // the way spawn()'s argv array does by default.
      // stdin is ignored because an open, never-written pipe makes claude wait ~3s for
      // input before starting, on every call.
      { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

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
      if (code !== 0 && stderr) opts.onEvent({ type: 'stderr', message: stderr });
      resolve({ success: code === 0, exitCode: code });
    });

    child.on('error', (err) => {
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
  optedInSkills?: string[];
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
    `Current code:\n\`\`\`tsx\n${opts.currentCode}\n\`\`\``,
    opts.priorError
      ? `Validation error from the previous attempt — fix this specifically:\n${opts.priorError}`
      : null,
    'Before writing code, check the skills available to you and load any whose description matches what this animation needs.',
    opts.optedInSkills && opts.optedInSkills.length > 0
      ? `The user explicitly enabled these skills for this request, so use them where they fit the creative intent: ${opts.optedInSkills.join(', ')}.`
      : null,
    'Follow the conventions in CLAUDE.md. Only modify this one file.',
  ].filter((s): s is string => Boolean(s));
  return sections.join('\n\n');
}
