import fs from 'node:fs';
import { runClaudeHeadless, buildRegeneratePrompt, withProjectLock } from './claude.js';
import { validateMarkerFile } from './validate.js';
import { smokeRenderFrames } from './render.js';
import { readCompositionConfig } from './composition.js';
import path from 'node:path';
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
  // The marker's voiceover line, which the visuals should support.
  narration?: string;
  // Skills marked optIn in their skill.json (paid or slow tools) are only available to Claude
  // when listed here.
  allowSkills: string[];
  compositionWidth: number;
  compositionHeight: number;
  regionWidth: number;
  regionHeight: number;
  isFullScreen: boolean;
  // Aborting stops the run (the browser that asked for it went away or the user cancelled).
  signal?: AbortSignal;
  onEvent: (e: { type: 'progress' | 'claude'; attempt?: number; phase?: string; error?: string; raw?: unknown }) => void;
}

export interface GenerateMarkerResult {
  success: boolean;
  code: string;
  error?: string;
  // The run was stopped; the marker's file was put back as it was before.
  cancelled?: boolean;
}

// The generate-then-validate retry loop shared by a single marker's own regenerate call
// and the bulk auto-plan apply flow — up to 3 attempts, each attempt's validation error fed
// back into the next attempt's prompt so Claude can self-correct.
export async function generateMarkerWithRetry(opts: GenerateMarkerOptions): Promise<GenerateMarkerResult> {
  let priorError: string | undefined;
  let success = false;
  let lastCode = fs.readFileSync(opts.file, 'utf-8');
  const originalCode = lastCode;
  refreshClaudeMd(opts.projectId);
  syncAssetModule(opts.projectId);
  const ctx = { project: opts.projectId, marker: opts.markerId };
  log('info', 'marker.generate', { ...ctx, prompt: clip(opts.prompt, 200), feedback: opts.feedback ? clip(opts.feedback, 200) : undefined, allowSkills: opts.allowSkills });

  const projectAssets = assetsForPrompt(opts.projectId, readMarkers(opts.projectId).find((m) => m.marker_id === opts.markerId)?.assets ?? []);
  if (projectAssets.attached.length > 0) log('info', 'marker.assets', { ...ctx, attached: projectAssets.attached.map((a) => a.id), library: projectAssets.library.length });

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (opts.signal?.aborted) {
      priorError = 'The request was cancelled.';
      break;
    }
    opts.onEvent({ type: 'progress', attempt, phase: 'invoking-claude' });

    const prompt = buildRegeneratePrompt({
      markerId: opts.markerId,
      currentCode: lastCode,
      prompt: opts.prompt,
      feedback: opts.feedback,
      priorError,
      transcript: opts.transcript,
      narration: opts.narration,
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
        signal: opts.signal,
        onEvent: (event) => opts.onEvent({ type: 'claude', raw: event }),
      });
      return { result, config };
    });

    if (!result.success) {
      priorError = result.failure?.message ?? `Claude process exited with code ${result.exitCode}`;
      log('warn', 'marker.claude_failed', { ...ctx, attempt, exitCode: result.exitCode, failure: result.failure?.kind });
      opts.onEvent({ type: 'progress', attempt, phase: 'claude-failed', error: priorError });
      // A signed-out CLI or a usage limit fails the same way every time; stop instead of burning attempts.
      if (result.failure && !result.failure.retryable) break;
      continue;
    }

    lastCode = fs.readFileSync(opts.file, 'utf-8');
    opts.onEvent({ type: 'progress', attempt, phase: 'validating' });
    const validation = await validateMarkerFile(opts.file, config.validatorExternals);
    logAttempt(opts.projectId, opts.markerId, attempt, lastCode, validation);
    log(validation.ok ? 'info' : 'warn', 'marker.validation', { ...ctx, attempt, ok: validation.ok, error: validation.ok ? undefined : clip(validation.error, 600) });

    if (validation.ok && !process.env.MANGO_SKIP_RENDER_CHECK) {
      // Bundling proves the file is well formed; rendering a few frames proves it runs.
      opts.onEvent({ type: 'progress', attempt, phase: 'rendering-check' });
      const marker = readMarkers(opts.projectId).find((m) => m.marker_id === opts.markerId);
      const { fps, durationInFrames } = readCompositionConfig(opts.projectId);
      const startFrame = Math.round((marker?.start ?? 0) * fps);
      const endFrame = Math.round((marker?.end ?? 1) * fps);
      const frames = [startFrame + 1, Math.round((startFrame + endFrame) / 2), endFrame - 2].map((f) => Math.min(Math.max(0, f), durationInFrames - 1));
      const smoke = await smokeRenderFrames(path.join(path.dirname(opts.file), 'Root.tsx'), [...new Set(frames)], path.join(path.dirname(opts.file), '..', '05_debug', 'smoke'));
      if (smoke.skipped) log('warn', 'marker.render_check_skipped', { ...ctx, attempt, reason: clip(smoke.error, 300) });
      else if (!smoke.ok) {
        log('warn', 'marker.render_check_failed', { ...ctx, attempt, error: clip(smoke.error, 600) });
        priorError = smoke.error;
        logAttempt(opts.projectId, opts.markerId, attempt, lastCode, { ok: false, error: smoke.error });
        opts.onEvent({ type: 'progress', attempt, phase: 'validation-failed', error: priorError });
        continue;
      }
    }

    if (validation.ok) {
      success = true;
      break;
    }
    priorError = validation.error;
    opts.onEvent({ type: 'progress', attempt, phase: 'validation-failed', error: priorError });
  }

  // A cancelled run says nothing about the marker: put back the code it had before (Claude may have
  // been halfway through editing it) and leave whatever status it had.
  if (opts.signal?.aborted) {
    try {
      if (fs.readFileSync(opts.file, 'utf-8') !== originalCode) fs.writeFileSync(opts.file, originalCode);
    } catch (err) {
      log('warn', 'marker.restore_failed', { ...ctx, error: err });
    }
    log('info', 'marker.cancelled', ctx);
    return { success: false, code: originalCode, error: 'Stopped.', cancelled: true };
  }
  updateMarkerStatus(opts.projectId, opts.markerId, opts.feedback, success ? 'ready' : 'error');
  log(success ? 'info' : 'error', 'marker.done', { ...ctx, status: success ? 'ready' : 'error', error: success ? undefined : clip(priorError, 300) });
  return { success, code: lastCode, error: success ? undefined : priorError };
}
