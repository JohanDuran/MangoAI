import fs from 'node:fs';
import { runClaudeHeadless, buildRegeneratePrompt, withProjectLock } from './claude.js';
import { validateMarkerFile } from './validate.js';
import { smokeRenderFrames, type SmokeRenderResult } from './render.js';
import { writeSmokeEntry } from './registry.js';
import { readCompositionConfig } from './composition.js';
import path from 'node:path';
import { logAttempt } from './debug.js';
import { updateMarkerStatus, readMarkers } from './markers.js';
import { assetsForPrompt } from './assets.js';
import { syncAssetModule } from './assetModule.js';
import { prepareClaudeCall, allSkillExternals } from './skills.js';
import {
  leadInstructions,
  memberInstructions,
  memberSource,
  readSharedComponent,
  sharedComponentFile,
  sharedComponentPath,
  type MarkerSeries,
  type SeriesComponent,
} from './series.js';
import { playableNarration } from './narration.js';
import { readPreset } from './presets.js';
import { log, clip } from './log.js';
import { runCommand } from './proc.js';
import { ffmpegBin } from './bin.js';
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
  // While applying a plan: the marker of a series that builds its shared component, with every
  // member's props so the component fits them all (see series.ts).
  seriesLead?: { component: SeriesComponent; allProps: Record<string, unknown>[] };
  // While applying a plan: a member of a series gets its file written by the runner (see series.ts),
  // and Claude only when that does not work.
  writeSeriesMember?: boolean;
  // While applying a plan: code of a marker of the same plan built first, to match its design.
  setReference?: { code: string };
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

// Rounds of the visual review after a marker first works (see reviewVisually); 0 turns it off.
const reviewRounds = () => {
  const n = Number(process.env.MANGO_VISUAL_REVIEW_ROUNDS ?? 1);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.floor(n))) : 1;
};

interface Still {
  file: string;
  // Seconds into the marker.
  seconds: number;
}

// Installing skills and running Claude happen under the same lock. Runs with the same skills go
// side by side; a run needing other skills waits, so the folder never changes under a run.
async function runClaudeOnMarker(opts: GenerateMarkerOptions, prompt: string, attempt: number, step: 'generate' | 'review') {
  const ctx = { project: opts.projectId, marker: opts.markerId };
  const queuedAt = Date.now();
  const enabled = enabledSkillNames(opts.projectId);
  const optedIn = opts.allowSkills.filter((s) => enabled.includes(s));
  const kind = `generate:${[...enabled].sort().join(',')}|${[...optedIn].sort().join(',')}`;
  return withProjectLock(opts.projectId, kind, async () => {
    const config = prepareClaudeCall({
      projectId: opts.projectId,
      enabled,
      optedIn: opts.allowSkills,
    });
    log('info', step === 'generate' ? 'marker.attempt' : 'marker.review', {
      ...ctx,
      attempt,
      waitedMs: Date.now() - queuedAt,
      activeSkills: config.activeSkills,
      skipped: config.skipped.length > 0 ? config.skipped.map((s) => `${s.name}(${s.reason})`) : undefined,
    });
    if (step === 'generate' && attempt === 1 && config.skipped.length > 0) {
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
      logContext: { ...ctx, attempt, ...(step === 'review' && { step }) },
      signal: opts.signal,
      onEvent: (event) => opts.onEvent({ type: 'claude', raw: event }),
    });
    return { result, config };
  });
}

// Renders three frames across the marker (early, middle, late) in headless Chrome. Bundling proves the
// file is well formed; this proves it runs. The frames are kept in 05_debug/smoke/<marker> for the
// visual review.
async function renderCheck(opts: GenerateMarkerOptions): Promise<SmokeRenderResult & { kept: Still[] }> {
  const marker = readMarkers(opts.projectId).find((m) => m.marker_id === opts.markerId);
  const { fps, durationInFrames } = readCompositionConfig(opts.projectId);
  const startFrame = Math.round((marker?.start ?? 0) * fps);
  const endFrame = Math.max(startFrame + 1, Math.round((marker?.end ?? 1) * fps));
  const at = (share: number) => Math.min(startFrame + Math.round((endFrame - startFrame) * share), endFrame - 1, durationInFrames - 1);
  const frames = [...new Set([at(0.15), at(0.5), at(0.85)].map((f) => Math.max(0, f)))];
  const dir = path.join(path.dirname(opts.file), '..', '05_debug', 'smoke', opts.markerId);
  fs.rmSync(dir, { recursive: true, force: true });
  const entry = writeSmokeEntry(opts.projectId, opts.markerId);
  const smoke = await smokeRenderFrames(entry, frames, dir, { keep: true }).finally(() => fs.rmSync(entry, { force: true }));
  const kept = (smoke.stills ?? []).map((file, i) => ({ file, seconds: (frames[i] - startFrame) / fps }));
  return { ...smoke, kept };
}

// Frames render on a transparent background, which an image viewer shows as white or black, so
// contrast cannot be judged from them. A copy on mid-gray (in the range of real footage) is what
// Claude looks at; the plain frame is used if that fails.
async function onGray(file: string): Promise<string> {
  const out = file.replace(/\.png$/, '.review.png');
  const made = await runCommand(
    ffmpegBin(),
    ['-v', 'error', '-y', '-i', file, '-filter_complex', 'color=c=0x5b6270,format=rgba[bg];[bg][0:v]scale2ref[bg2][fg];[bg2][fg]overlay=format=auto', '-frames:v', '1', out],
    { timeoutMs: 30_000 }
  ).catch(() => null);
  return made && made.code === 0 && fs.existsSync(out) ? out : file;
}

// What the visual review may change in a marker of a series: the lead may still fix its shared
// component; any other member only its own props, since the shared design is used by the others too.
function seriesReviewNote(series: MarkerSeries | undefined, buildsShared: boolean): string | null {
  if (!series) return null;
  const shared = sharedComponentPath(series.component);
  return buildsShared
    ? `It renders the shared component ${shared}, which the other markers of its series render too with their own props. Fix defects in whichever of the two files they come from, and keep the component working for every marker of the series.`
    : `It renders the shared component ${shared} with its own props, like the other markers of its series. Fix defects only through this file's props (for example a shorter wording); never edit the shared component or rebuild the design here.`;
}

function buildVisualReviewPrompt(opts: GenerateMarkerOptions, stills: Still[], look?: string, series?: MarkerSeries): string {
  const file = `03_remotion_code/marker_${opts.markerId}.tsx`;
  const buildsShared = !!(series && opts.seriesLead);
  return [
    `You built the overlay animation in ${file}. Now check how it actually looks.`,
    `Its creative intent: ${opts.prompt}`,
    opts.feedback ? `The creator's latest feedback: ${opts.feedback}` : null,
    opts.narration ? `A voiceover says during it: "${opts.narration}"` : null,
    look ? `It shares this look with the other markers of the video:\n${look}` : null,
    seriesReviewNote(series, buildsShared),
    `Its area is ${opts.regionWidth}x${opts.regionHeight}px${opts.isFullScreen ? ' (the full canvas)' : ` inside a ${opts.compositionWidth}x${opts.compositionHeight}px canvas`}. These are frames of it, placed on a plain mid-gray background that stands in for the footage the overlay will sit on:`,
    stills.map((s) => `- ${s.file} (${s.seconds.toFixed(1)}s into the marker)`).join('\n'),
    [
      'Read each image and review it as a demanding motion designer who did not build it: judge what the pixels show, not what the code intends. Go through the frames element by element, and for each piece of text and each card or box write down:',
      '- the gap between it and the edges of the box it sits in (or of the area), as a rough percentage of that box. A gap under about 5% on any side is a defect, even when nothing is cut off: text that fills its card from edge to edge looks cramped.',
      '- whether it is cut off, overflows, or overlaps something it should not',
      '- whether it is readable at this size and against the gray (which stands in for footage)',
      'Then also check each frame as a whole: empty where something should be showing, placeholder text, wrong numbers or facts, anything contradicting the intent, an unbalanced or misaligned layout.',
    ].join('\n'),
    `List every defect you found. If there are any, fix them in ${file}${buildsShared ? ` or ${sharedComponentPath(series!.component)}` : ' (only that file)'}, for example by shrinking the text or widening its box, keep everything that works, and update its design spec comment to match. If there are none, change nothing; do not restyle something that works just to change it.`,
    'End your reply with one line: "REVIEW: fixed" if you changed the file, or "REVIEW: ok" if not.',
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

// After a marker works, Claude looks at rendered frames of it and fixes what it sees (clipped or
// overflowing text, things outside the area, unreadable or empty frames). A fix that breaks the
// marker is undone, so the review can only keep or improve a working marker.
async function reviewVisually(opts: GenerateMarkerOptions, stills: Still[], look: string | undefined, series: MarkerSeries | undefined): Promise<void> {
  const ctx = { project: opts.projectId, marker: opts.markerId };
  // The lead may fix the shared component too; it is put back along with the marker on a bad fix.
  const sharedFile = series && opts.seriesLead ? sharedComponentFile(opts.projectId, series.component) : null;
  for (let round = 1; round <= reviewRounds() && stills.length > 0; round++) {
    if (opts.signal?.aborted) return;
    opts.onEvent({ type: 'progress', attempt: round, phase: 'reviewing' });
    const before = fs.readFileSync(opts.file, 'utf-8');
    const sharedBefore = sharedFile ? readFileOrNull(sharedFile) : null;
    const putBack = () => {
      fs.writeFileSync(opts.file, before);
      if (sharedFile && sharedBefore !== null) fs.writeFileSync(sharedFile, sharedBefore);
    };
    const shown = await Promise.all(stills.map(async (s) => ({ ...s, file: await onGray(s.file) })));
    const relative = shown.map((s) => ({ ...s, file: path.relative(opts.cwd, s.file).split(path.sep).join('/') }));
    const { result, config } = await runClaudeOnMarker(opts, buildVisualReviewPrompt(opts, relative, look, series), round, 'review');
    if (opts.signal?.aborted) return;
    const after = fs.readFileSync(opts.file, 'utf-8');
    const changed = after !== before || (sharedFile !== null && readFileOrNull(sharedFile) !== sharedBefore);
    if (!result.success || !changed) {
      if (changed) putBack();
      log('info', 'marker.review_done', { ...ctx, round, changed: false, failure: result.failure?.kind });
      return;
    }
    const validation = await validateMarkerFile(opts.file, config.validatorExternals);
    logAttempt(opts.projectId, opts.markerId, 100 + round, after, validation);
    const smoke = validation.ok ? await renderCheck(opts) : null;
    if (!smoke || !smoke.ok) {
      const error = smoke ? smoke.error : validation.error;
      log('warn', 'marker.review_reverted', { ...ctx, round, error: clip(error, 600) });
      opts.onEvent({ type: 'progress', attempt: round, phase: 'review-reverted', error });
      putBack();
      return;
    }
    log('info', 'marker.review_done', { ...ctx, round, changed: true });
    opts.onEvent({ type: 'progress', attempt: round, phase: 'review-fixed' });
    stills = smoke.kept;
  }
}

const readFileOrNull = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

// Validates the marker file and renders a few frames of it; the frames are kept for the visual review.
async function checkMarker(opts: GenerateMarkerOptions, externals: string[], attempt: number): Promise<{ ok: true; stills: Still[] } | { ok: false; error: string }> {
  const ctx = { project: opts.projectId, marker: opts.markerId };
  const code = fs.readFileSync(opts.file, 'utf-8');
  opts.onEvent({ type: 'progress', attempt, phase: 'validating' });
  const validation = await validateMarkerFile(opts.file, externals);
  logAttempt(opts.projectId, opts.markerId, attempt, code, validation);
  log(validation.ok ? 'info' : 'warn', 'marker.validation', { ...ctx, attempt, ok: validation.ok, error: validation.ok ? undefined : clip(validation.error, 600) });
  if (!validation.ok) return { ok: false, error: validation.error ?? 'The code did not build.' };
  if (process.env.MANGO_SKIP_RENDER_CHECK) return { ok: true, stills: [] };
  opts.onEvent({ type: 'progress', attempt, phase: 'rendering-check' });
  const smoke = await renderCheck(opts);
  if (smoke.skipped) {
    log('warn', 'marker.render_check_skipped', { ...ctx, attempt, reason: clip(smoke.error, 300) });
    return { ok: true, stills: [] };
  }
  if (!smoke.ok) {
    log('warn', 'marker.render_check_failed', { ...ctx, attempt, error: clip(smoke.error, 600) });
    logAttempt(opts.projectId, opts.markerId, attempt, code, { ok: false, error: smoke.error });
    return { ok: false, error: smoke.error ?? 'The animation failed to render.' };
  }
  return { ok: true, stills: smoke.kept };
}

// The lead of a series has to leave a shared component that its marker actually renders, or the
// other markers would render something nobody checked.
function leadProblem(opts: GenerateMarkerOptions, series: MarkerSeries): string | null {
  const shared = sharedComponentPath(series.component);
  if (!fs.existsSync(sharedComponentFile(opts.projectId, series.component))) return `${shared} was not created. Create it, and render it from the marker file.`;
  if (!fs.readFileSync(opts.file, 'utf-8').includes(`./shared/${series.component}`)) {
    return `The marker file does not import ./shared/${series.component}. The marker must render the shared component, since the other markers of the series will.`;
  }
  return null;
}

// The generate-then-validate retry loop shared by a single marker's own regenerate call
// and the bulk auto-plan apply flow — up to 3 attempts, each attempt's validation error fed
// back into the next attempt's prompt so Claude can self-correct. A marker that works then gets a
// visual review (see reviewVisually).
export async function generateMarkerWithRetry(opts: GenerateMarkerOptions): Promise<GenerateMarkerResult> {
  let priorError: string | undefined;
  let success = false;
  let lastCode = fs.readFileSync(opts.file, 'utf-8');
  const originalCode = lastCode;
  refreshClaudeMd(opts.projectId);
  syncAssetModule(opts.projectId);
  const ctx = { project: opts.projectId, marker: opts.markerId };
  log('info', 'marker.generate', { ...ctx, prompt: clip(opts.prompt, 200), feedback: opts.feedback ? clip(opts.feedback, 200) : undefined, allowSkills: opts.allowSkills });

  const thisMarker = readMarkers(opts.projectId).find((m) => m.marker_id === opts.markerId);
  const projectAssets = assetsForPrompt(opts.projectId, thisMarker?.assets ?? []);
  // When each word of the marker's current voice take is spoken, so the animation can hit them.
  const narrationWords = opts.narration && thisMarker && playableNarration(opts.projectId, thisMarker) ? thisMarker.narration?.audio?.words : undefined;
  // The look to match, when the marker has a style preset.
  const preset = thisMarker?.stylePreset ? readPreset(thisMarker.stylePreset) : null;
  const styleReference = preset ? { name: preset.name, code: preset.code } : undefined;
  // The look shared with the markers planned together with this one.
  const look = thisMarker?.look;
  // A marker of a series renders the shared component (see series.ts). Its lead builds it; any other
  // member gets its file written by the runner while a plan is applied, and Claude only when that
  // does not work; Claude always handles a regenerate.
  const series = thisMarker?.series;
  const sharedFile = series ? sharedComponentFile(opts.projectId, series.component) : null;
  const originalShared = sharedFile && opts.seriesLead ? readFileOrNull(sharedFile) : null;
  const sharedCode = series && !opts.seriesLead ? readSharedComponent(opts.projectId, series.component) : null;
  const seriesPrompt = series
    ? opts.seriesLead
      ? { instructions: leadInstructions(opts.markerId, opts.seriesLead.component, series.props, opts.seriesLead.allProps), buildsShared: true }
      : sharedCode
        ? { instructions: memberInstructions(series, sharedCode), buildsShared: false }
        : undefined
    : undefined;
  if (projectAssets.attached.length > 0) log('info', 'marker.assets', { ...ctx, attached: projectAssets.attached.map((a) => a.id), library: projectAssets.library.length });
  let stills: Still[] = [];

  if (series && sharedCode && opts.writeSeriesMember && !opts.signal?.aborted) {
    fs.writeFileSync(opts.file, memberSource(opts.markerId, series));
    const check = await checkMarker(opts, allSkillExternals(), 0);
    log(check.ok ? 'info' : 'warn', 'marker.series_member', { ...ctx, component: series.component, ok: check.ok });
    if (check.ok) {
      success = true;
      stills = check.stills;
    } else priorError = check.error;
    lastCode = fs.readFileSync(opts.file, 'utf-8');
  }

  for (let attempt = 1; attempt <= 3 && !success; attempt++) {
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
      narrationWords,
      styleReference,
      look,
      setReference: opts.setReference,
      series: seriesPrompt,
      optedInSkills: opts.allowSkills,
      compositionWidth: opts.compositionWidth,
      compositionHeight: opts.compositionHeight,
      regionWidth: opts.regionWidth,
      regionHeight: opts.regionHeight,
      isFullScreen: opts.isFullScreen,
      attachedAssets: projectAssets.attached,
      libraryAssets: projectAssets.library,
    });

    const { result, config } = await runClaudeOnMarker(opts, prompt, attempt, 'generate');

    if (!result.success) {
      priorError = result.failure?.message ?? `Claude process exited with code ${result.exitCode}`;
      log('warn', 'marker.claude_failed', { ...ctx, attempt, exitCode: result.exitCode, failure: result.failure?.kind });
      opts.onEvent({ type: 'progress', attempt, phase: 'claude-failed', error: priorError });
      // A signed-out CLI or a usage limit fails the same way every time; stop instead of burning attempts.
      if (result.failure && !result.failure.retryable) break;
      continue;
    }

    lastCode = fs.readFileSync(opts.file, 'utf-8');
    const problem = series && opts.seriesLead ? leadProblem(opts, series) : null;
    const check = problem ? ({ ok: false, error: problem } as const) : await checkMarker(opts, config.validatorExternals, attempt);
    if (check.ok) {
      success = true;
      stills = check.stills;
      break;
    }
    priorError = check.error;
    opts.onEvent({ type: 'progress', attempt, phase: 'validation-failed', error: priorError });
  }

  if (success && !opts.signal?.aborted) {
    await reviewVisually(opts, stills, look, series);
    lastCode = fs.readFileSync(opts.file, 'utf-8');
  }

  // A cancelled run says nothing about the marker: put back the code it had before (Claude may have
  // been halfway through editing it) and leave whatever status it had.
  if (opts.signal?.aborted) {
    try {
      if (fs.readFileSync(opts.file, 'utf-8') !== originalCode) fs.writeFileSync(opts.file, originalCode);
      if (sharedFile && opts.seriesLead) {
        if (originalShared === null) fs.rmSync(sharedFile, { force: true });
        else fs.writeFileSync(sharedFile, originalShared);
      }
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
