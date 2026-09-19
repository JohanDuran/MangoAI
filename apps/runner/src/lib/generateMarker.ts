import fs from 'node:fs';
import { runClaudeHeadless, buildRegeneratePrompt, withProjectLock } from './claude.js';
import { validateMarkerFile } from './validate.js';
import { logAttempt } from './debug.js';
import { updateMarkerStatus } from './markers.js';
import { prepareClaudeCall } from './skills.js';
import { enabledSkillNames, refreshClaudeMd } from './scaffold.js';

export interface GenerateMarkerOptions {
  projectId: string;
  markerId: string;
  cwd: string;
  file: string;
  prompt: string;
  feedback: string;
  transcript?: string;
  // Skills marked optIn in their skill.json (paid or slow tools) are only available to Claude
  // when listed here.
  allowSkills: string[];
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
  refreshClaudeMd(opts.projectId);

  for (let attempt = 1; attempt <= 3; attempt++) {
    opts.onEvent({ type: 'progress', attempt, phase: 'invoking-claude' });

    const prompt = buildRegeneratePrompt({
      markerId: opts.markerId,
      currentCode: lastCode,
      prompt: opts.prompt,
      feedback: opts.feedback,
      priorError,
      transcript: opts.transcript,
      optedInSkills: opts.allowSkills,
      compositionWidth: opts.compositionWidth,
      compositionHeight: opts.compositionHeight,
      regionWidth: opts.regionWidth,
      regionHeight: opts.regionHeight,
      isFullScreen: opts.isFullScreen,
    });

    // Installing skills and running Claude happen under the same lock, so a queued run for
    // another marker can never change the skills folder underneath this one.
    const { result, config } = await withProjectLock(opts.projectId, async () => {
      const config = prepareClaudeCall({
        projectId: opts.projectId,
        enabled: enabledSkillNames(opts.projectId),
        optedIn: opts.allowSkills,
      });
      if (attempt === 1 && config.skipped.length > 0) {
        opts.onEvent({
          type: 'progress',
          attempt,
          phase: 'skills-skipped',
          error: config.skipped.map((s) => `${s.name} (${s.reason})`).join(', '),
        });
      }
      const result = await runClaudeHeadless({
        cwd: opts.cwd,
        prompt,
        tools: config.tools,
        allowedTools: config.allowedTools,
        mcpConfigPath: config.mcpConfigPath,
        envExclude: config.envExclude,
        onEvent: (event) => opts.onEvent({ type: 'claude', raw: event }),
      });
      return { result, config };
    });

    if (!result.success) {
      priorError = `Claude process exited with code ${result.exitCode}`;
      opts.onEvent({ type: 'progress', attempt, phase: 'claude-failed', error: priorError });
      continue;
    }

    lastCode = fs.readFileSync(opts.file, 'utf-8');
    opts.onEvent({ type: 'progress', attempt, phase: 'validating' });
    const validation = await validateMarkerFile(opts.file, config.validatorExternals);
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
