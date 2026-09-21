import fs from 'node:fs';
import { runClaudeHeadless, buildRegeneratePrompt, withProjectLock } from './claude.js';
import { validateMarkerFile } from './validate.js';
import { logAttempt } from './debug.js';
import { updateMarkerStatus, readMarkers } from './markers.js';
import { assetsForPrompt } from './assets.js';
import { syncAssetModule } from './assetModule.js';
import { prepareClaudeCall } from './skills.js';
import { log, clip } from './log.js';
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
  syncAssetModule(opts.projectId);
  const ctx = { project: opts.projectId, marker: opts.markerId };
  log('info', 'marker.generate', { ...ctx, prompt: clip(opts.prompt, 200), feedback: opts.feedback ? clip(opts.feedback, 200) : undefined, allowSkills: opts.allowSkills });

  const projectAssets = assetsForPrompt(opts.projectId, readMarkers(opts.projectId).find((m) => m.marker_id === opts.markerId)?.assets ?? []);
  if (projectAssets.attached.length > 0) log('info', 'marker.assets', { ...ctx, attached: projectAssets.attached.map((a) => a.id), library: projectAssets.library.length });

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
      attachedAssets: projectAssets.attached,
      libraryAssets: projectAssets.library,
    });

    // Installing skills and running Claude happen under the same lock, so a queued run for
    // another marker can never change the skills folder underneath this one.
    const queuedAt = Date.now();
    const { result, config } = await withProjectLock(opts.projectId, async () => {
      const config = prepareClaudeCall({
        projectId: opts.projectId,
        enabled: enabledSkillNames(opts.projectId),
        optedIn: opts.allowSkills,
      });
      log('info', 'marker.attempt', {
        ...ctx,
        attempt,
        waitedMs: Date.now() - queuedAt,
        activeSkills: config.activeSkills,
        skipped: config.skipped.length > 0 ? config.skipped.map((s) => `${s.name}(${s.reason})`) : undefined,
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
        logContext: { ...ctx, attempt },
        onEvent: (event) => opts.onEvent({ type: 'claude', raw: event }),
      });
      return { result, config };
    });

    if (!result.success) {
      priorError = `Claude process exited with code ${result.exitCode}`;
      log('warn', 'marker.claude_failed', { ...ctx, attempt, exitCode: result.exitCode });
      opts.onEvent({ type: 'progress', attempt, phase: 'claude-failed', error: priorError });
      continue;
    }

    lastCode = fs.readFileSync(opts.file, 'utf-8');
    opts.onEvent({ type: 'progress', attempt, phase: 'validating' });
    const validation = await validateMarkerFile(opts.file, config.validatorExternals);
    logAttempt(opts.projectId, opts.markerId, attempt, lastCode, validation);
    log(validation.ok ? 'info' : 'warn', 'marker.validation', { ...ctx, attempt, ok: validation.ok, error: validation.ok ? undefined : clip(validation.error, 600) });

    if (validation.ok) {
      success = true;
      break;
    }
    priorError = validation.error;
    opts.onEvent({ type: 'progress', attempt, phase: 'validation-failed', error: priorError });
  }

  updateMarkerStatus(opts.projectId, opts.markerId, opts.feedback, success ? 'ready' : 'error');
  log(success ? 'info' : 'error', 'marker.done', { ...ctx, status: success ? 'ready' : 'error', error: success ? undefined : clip(priorError, 300) });
  return { success, code: lastCode, error: success ? undefined : priorError };
}
