import { projectDir } from './paths.js';
import { readMarkers, isValidRegion, type MarkerRegion } from './markers.js';
import { readTranscript, type TranscriptSegment } from './transcript.js';
import { readCompositionConfig } from './composition.js';
import { runClaudeHeadlessCapturingText, withProjectLock } from './claude.js';
import { log } from './log.js';
import { readAssets, validAssetIds, type Asset } from './assets.js';

export interface ProposedMarker {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  // Ids of library images Claude suggests attaching to this marker.
  assets: string[];
}

export interface PlanMarkersResult {
  proposals: ProposedMarker[];
  droppedCount: number;
}

interface TimeRange {
  start: number;
  end: number;
}

// Same overlap test as transcript.ts's transcriptForRange, reused for consistency.
const overlapsAny = (candidate: TimeRange, ranges: TimeRange[]): boolean =>
  ranges.some((r) => candidate.start < r.end && candidate.end > r.start);

const isValidRange = (r: TimeRange, durationSeconds: number): boolean =>
  Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end > r.start && r.end <= durationSeconds + 0.001;

function buildPlanPrompt(opts: {
  segments: TranscriptSegment[];
  durationSeconds: number;
  width: number;
  height: number;
  existing: { start: number; end: number; prompt: string }[];
  library: Asset[];
  context?: string;
}): string {
  const transcriptLines = opts.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
  const existingLines =
    opts.existing.length > 0
      ? opts.existing.map((m) => `- [${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.prompt}`).join('\n')
      : '(none)';

  const libraryLines = opts.library
    .map((a) => `- id ${a.id}: "${a.name}"${a.width && a.height ? ` (${a.width}x${a.height})` : ''} — ${a.description ?? 'no description, so only use it if the name makes its content obvious'}`)
    .join('\n');

  return [
    `You are planning on-screen animated overlays for a video, based on its transcript. The video is ${opts.width}x${opts.height}px and ${opts.durationSeconds.toFixed(1)} seconds long.`,
    `Transcript (seconds, one segment per line):\n${transcriptLines}`,
    `Markers that already exist — do not propose anything overlapping these time ranges:\n${existingLines}`,
    opts.context
      ? `Instructions from the creator — follow these closely; they take priority over whatever you'd otherwise infer from the transcript alone:\n${opts.context}`
      : null,
    `Decide where an animated overlay would meaningfully support what's being said (e.g. calling out a key stat, highlighting a quote, illustrating a concept) — do not propose one for every segment, only where it adds value. For each, decide a time range, a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae), and whether it should be confined to a sub-area of the screen or use the full screen.`,
    opts.library.length > 0
      ? `The user uploaded these images to the project library:\n${libraryLines}\nWhen an image clearly belongs to a marker (for example a logo when that brand is mentioned, or a screenshot of the thing being discussed), list its id in that marker's "assets" array and write the prompt so it says how the image fits. Most markers need no image; never invent ids and never attach an image just to use it.`
      : null,
    `Respond with ONLY a JSON array, no prose, no markdown code fences, of objects shaped exactly like:\n[{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}${opts.library.length > 0 ? ', "assets": string[]' : ''}}]`,
    `Rules: start/end are seconds within [0, ${opts.durationSeconds.toFixed(1)}]. region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1). No two proposed ranges may overlap each other or any existing marker listed above.`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function extractJsonArray(text: string): unknown[] {
  const attempts: (() => unknown)[] = [
    () => JSON.parse(text.trim()),
    () => {
      const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
      if (!match) throw new Error('no fenced block');
      return JSON.parse(match[1].trim());
    },
    () => {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end === -1 || end < start) throw new Error('no array brackets found');
      return JSON.parse(text.slice(start, end + 1));
    },
  ];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (Array.isArray(value)) return value;
    } catch {
      // try the next strategy
    }
  }
  throw new Error(`Planner response was not a parseable JSON array: ${text.slice(0, 300)}`);
}

function normalizeCandidate(item: unknown, projectId: string): ProposedMarker | null {
  if (!item || typeof item !== 'object') return null;
  const { start, end, prompt, region, assets } = item as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' || typeof prompt !== 'string' || !prompt.trim()) return null;
  if (region !== null && region !== undefined && !isValidRegion(region)) return null;
  return { start, end, prompt: prompt.trim(), region: region ? (region as MarkerRegion) : null, assets: validAssetIds(projectId, assets) };
}

function buildIdeaPlanPrompt(opts: {
  idea: string;
  durationSeconds: number;
  width: number;
  height: number;
  existing: { start: number; end: number; prompt: string }[];
  library: Asset[];
}): string {
  const existingLines =
    opts.existing.length > 0
      ? opts.existing.map((m) => `- [${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.prompt}`).join('\n')
      : '(none)';

  const libraryLines = opts.library
    .map((a) => `- id ${a.id}: "${a.name}"${a.width && a.height ? ` (${a.width}x${a.height})` : ''} — ${a.description ?? 'no description, so only use it if the name makes its content obvious'}`)
    .join('\n');

  return [
    `You are designing a full storyboard of on-screen animated overlays for a video from the creator's idea below. There is no transcript — you are inventing the content and pacing, not illustrating spoken words. The video is ${opts.width}x${opts.height}px and ${opts.durationSeconds.toFixed(1)} seconds long.`,
    `The creator's idea:\n${opts.idea}`,
    `Break the idea into a sequence of multiple correlated markers that together cover the video from 0s to ${opts.durationSeconds.toFixed(1)}s — do not propose just one marker. Think of it as a storyboard: decide how many distinct beats the idea needs, order them narratively, and space them across the full duration so the video isn't front-loaded with content and empty afterward. Consecutive markers may sit back-to-back, but must not overlap.`,
    `Markers that already exist — do not propose anything overlapping these time ranges:\n${existingLines}`,
    `For each marker, decide a time range, a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae), and whether it should be confined to a sub-area of the screen or use the full screen.`,
    opts.library.length > 0
      ? `The user uploaded these images to the project library:\n${libraryLines}\nWhen an image clearly belongs to a marker (for example a logo when that brand is mentioned, or a screenshot of the thing being discussed), list its id in that marker's "assets" array and write the prompt so it says how the image fits. Most markers need no image; never invent ids and never attach an image just to use it.`
      : null,
    `Respond with ONLY a JSON array, no prose, no markdown code fences, of objects shaped exactly like:\n[{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}${opts.library.length > 0 ? ', "assets": string[]' : ''}}]`,
    `Rules: start/end are seconds within [0, ${opts.durationSeconds.toFixed(1)}]. region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1). No two proposed ranges may overlap each other or any existing marker listed above.`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function finalizeProposals(raw: unknown[], id: string, durationSeconds: number, existing: TimeRange[]): PlanMarkersResult {
  const proposals: ProposedMarker[] = [];
  let droppedCount = 0;
  for (const item of raw) {
    const candidate = normalizeCandidate(item, id);
    if (
      candidate &&
      isValidRange(candidate, durationSeconds) &&
      !overlapsAny(candidate, existing) &&
      !overlapsAny(candidate, proposals)
    ) {
      proposals.push(candidate);
    } else {
      droppedCount++;
    }
  }
  return { proposals, droppedCount };
}

export async function planMarkers(id: string, context?: string): Promise<PlanMarkersResult> {
  const segments = readTranscript(id);
  if (segments.length === 0) throw new Error('No transcript yet — transcribe the video first.');

  const markers = readMarkers(id);
  const { width, height, fps, durationInFrames } = readCompositionConfig(id);
  const durationSeconds = durationInFrames / fps;

  const prompt = buildPlanPrompt({
    segments,
    durationSeconds,
    width,
    height,
    existing: markers.map((m) => ({ start: m.start, end: m.end, prompt: m.prompt })),
    library: readAssets(id),
    context: context?.trim() || undefined,
  });

  const { text } = await withProjectLock(id, () =>
    runClaudeHeadlessCapturingText({
      cwd: projectDir(id),
      prompt,
      tools: [],
      logContext: { project: id, purpose: 'plan-markers' },
      onEvent: () => {},
    })
  );

  const raw = extractJsonArray(text);
  const result = finalizeProposals(raw, id, durationSeconds, markers);

  log('info', 'plan.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount });
  return result;
}

export async function planMarkersFromIdea(id: string, idea: string): Promise<PlanMarkersResult> {
  const trimmedIdea = idea.trim();
  if (!trimmedIdea) throw new Error('Describe the idea for the AI to design markers from.');

  const markers = readMarkers(id);
  const { width, height, fps, durationInFrames } = readCompositionConfig(id);
  const durationSeconds = durationInFrames / fps;

  const prompt = buildIdeaPlanPrompt({
    idea: trimmedIdea,
    durationSeconds,
    width,
    height,
    existing: markers.map((m) => ({ start: m.start, end: m.end, prompt: m.prompt })),
    library: readAssets(id),
  });

  const { text } = await withProjectLock(id, () =>
    runClaudeHeadlessCapturingText({
      cwd: projectDir(id),
      prompt,
      tools: [],
      logContext: { project: id, purpose: 'plan-markers-from-idea' },
      onEvent: () => {},
    })
  );

  const raw = extractJsonArray(text);
  const result = finalizeProposals(raw, id, durationSeconds, markers);

  log('info', 'plan-from-idea.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount });
  return result;
}
