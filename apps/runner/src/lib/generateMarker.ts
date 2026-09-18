import fs from 'node:fs';
import { runClaudeHeadless, buildRegeneratePrompt } from './claude.js';
import { validateMarkerFile } from './validate.js';
import { logAttempt } from './debug.js';
import { updateMarkerStatus } from './markers.js';

export interface GenerateMarkerOptions {
  projectId: string;
  markerId: string;
  cwd: string;
  file: string;
  prompt: string;
  feedback: string;
  transcript?: string;
  imageUrl?: string;
  compositionWidth: number;
  compositionHeight: number;
  regionWidth: number;
  regionHeight: number;
  isFullScreen: boolean;
  onEvent: (e: { type: 'progress' | 'claude'; attempt?: number; phase?: string; error?: string; raw?: unknown }) => void;
}

export interface GenerateMarkerResult {
  success: boolean;
  code: string;
  error?: string;
}

// The generate-then-validate retry loop shared by a single marker's own regenerate call
// and the bulk auto-plan apply flow — up to 3 attempts, each attempt's validation error fed
// back into the next attempt's prompt so Claude can self-correct.
export async function generateMarkerWithRetry(opts: GenerateMarkerOptions): Promise<GenerateMarkerResult> {
  let priorError: string | undefined;
  let success = false;
  let lastCode = fs.readFileSync(opts.file, 'utf-8');

  for (let attempt = 1; attempt <= 3; attempt++) {
    opts.onEvent({ type: 'progress', attempt, phase: 'invoking-claude' });

    const prompt = buildRegeneratePrompt({
      markerId: opts.markerId,
      currentCode: lastCode,
      prompt: opts.prompt,
      feedback: opts.feedback,
      priorError,
      transcript: opts.transcript,
      imageUrl: opts.imageUrl,
      compositionWidth: opts.compositionWidth,
      compositionHeight: opts.compositionHeight,
      regionWidth: opts.regionWidth,
      regionHeight: opts.regionHeight,
      isFullScreen: opts.isFullScreen,
    });

    const result = await runClaudeHeadless({
      projectId: opts.projectId,
      cwd: opts.cwd,
      prompt,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      onEvent: (event) => opts.onEvent({ type: 'claude', raw: event }),
    });

    if (!result.success) {
      priorError = `Claude process exited with code ${result.exitCode}`;
      opts.onEvent({ type: 'progress', attempt, phase: 'claude-failed', error: priorError });
      continue;
    }

    lastCode = fs.readFileSync(opts.file, 'utf-8');
    opts.onEvent({ type: 'progress', attempt, phase: 'validating' });
    const validation = await validateMarkerFile(opts.file);
    logAttempt(opts.projectId, opts.markerId, attempt, lastCode, validation);

    if (validation.ok) {
      success = true;
      break;
    }
    priorError = validation.error;
    opts.onEvent({ type: 'progress', attempt, phase: 'validation-failed', error: priorError });
  }

  updateMarkerStatus(opts.projectId, opts.markerId, opts.feedback, success ? 'ready' : 'error');
  return { success, code: lastCode, error: success ? undefined : priorError };
}
