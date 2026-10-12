import { projectDir } from './paths.js';
import { readMarkers, isValidRegion, type MarkerRegion } from './markers.js';
import { readTranscript, type TranscriptSegment } from './transcript.js';
import { readCompositionConfig } from './composition.js';
import { runClaudeHeadlessCapturingText, withProjectLock } from './claude.js';
import { log } from './log.js';
import { readAssets, validAssetIds, type Asset } from './assets.js';
import { MAX_NARRATION_CHARS } from './narration.js';

export interface ProposedMarker {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  // Ids of library images Claude suggests attaching to this marker.
  assets: string[];
  // A voiceover line to speak from the marker's start; empty for none.
  narration: string;
  // Whether generating the marker may create an image with AI (the image-generation skill).
  generateImage: boolean;
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

// Prompt lines shared by the planners and the idea chat (ideaChat.ts).
export const existingMarkerLines = (existing: { start: number; end: number; prompt: string }[]): string =>
  existing.length > 0 ? existing.map((m) => `- [${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.prompt}`).join('\n') : '(none)';

export const libraryAssetLines = (library: Asset[]): string =>
  library
    .map((a) => `- id ${a.id}: "${a.name}"${a.width && a.height ? ` (${a.width}x${a.height})` : ''} — ${a.description ?? 'no description, so only use it if the name makes its content obvious'}`)
    .join('\n');

export const areaInPixels = (area: MarkerRegion, width: number, height: number): string =>
  `${Math.round(area.width * width)}x${Math.round(area.height * height)}px with its top-left corner at (${Math.round(area.x * width)}, ${Math.round(area.y * height)})`;

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
  const existingLines = existingMarkerLines(opts.existing);
  const libraryLines = libraryAssetLines(opts.library);

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
  const { start, end, prompt, region, assets, narration, generateImage } = item as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' || typeof prompt !== 'string' || !prompt.trim()) return null;
  if (region !== null && region !== undefined && !isValidRegion(region)) return null;
  return {
    start,
    end,
    prompt: prompt.trim(),
    region: region ? (region as MarkerRegion) : null,
    assets: validAssetIds(projectId, assets),
    narration: typeof narration === 'string' ? narration.trim().slice(0, MAX_NARRATION_CHARS) : '',
    generateImage: generateImage === true,
  };
}

function buildIdeaPlanPrompt(opts: {
  idea: string;
  durationSeconds: number;
  width: number;
  height: number;
  existing: { start: number; end: number; prompt: string }[];
  library: Asset[];
  // The area the creator picked for every marker; absent lets Claude choose per marker.
  region?: MarkerRegion;
  // Whether to write a voiceover line for each marker.
  narration?: boolean;
  // Whether markers may get an image generated with AI.
  images?: boolean;
}): string {
  const existingLines = existingMarkerLines(opts.existing);
  const libraryLines = libraryAssetLines(opts.library);

  const area = opts.region;
  const areaPx = area ? areaInPixels(area, opts.width, opts.height) : '';

  return [
    `You are designing a full storyboard of on-screen animated overlays for a video from the creator's idea below. There is no transcript — you are inventing the content and pacing, not illustrating spoken words. The video is ${opts.width}x${opts.height}px and ${opts.durationSeconds.toFixed(1)} seconds long.`,
    `The creator's brief, usually agreed with them in a planning conversation. Follow it closely: when it lists beats, keep them, in its order and roughly at its timings, and keep any style, wording or must-haves it gives. Fill in only what it leaves open:\n${opts.idea}`,
    `Break the idea into a sequence of multiple correlated markers that together cover the video from 0s to ${opts.durationSeconds.toFixed(1)}s — do not propose just one marker. Think of it as a storyboard: decide how many distinct beats the idea needs, order them narratively, and space them across the full duration so the video isn't front-loaded with content and empty afterward. Consecutive markers may sit back-to-back, but must not overlap.`,
    `Markers that already exist — do not propose anything overlapping these time ranges:\n${existingLines}`,
    area
      ? `For each marker, decide a time range and a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae). Every marker is confined to the same area the creator chose: ${areaPx} of the ${opts.width}x${opts.height}px canvas. Design content that suits that area's size and shape.`
      : `For each marker, decide a time range, a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae), and whether it should be confined to a sub-area of the screen or use the full screen.`,
    opts.library.length > 0
      ? `The user uploaded these images to the project library:\n${libraryLines}\nWhen an image clearly belongs to a marker (for example a logo when that brand is mentioned, or a screenshot of the thing being discussed), list its id in that marker's "assets" array and write the prompt so it says how the image fits. Most markers need no image; never invent ids and never attach an image just to use it.`
      : null,
    opts.narration
      ? `The video also gets a voiceover. For each marker write "narration": the exact words a voice reads aloud starting at the marker's start, continuing the story from the previous marker so the whole voiceover reads as one script. A voice speaks about 2.5 words per second, so keep each line to at most 2.5 words per second of its marker (a 4-second marker gets at most 10 words); make a marker longer rather than cramming words in. Write plain spoken text: no stage directions, emoji or markup. The animation should show what the line says.`
      : null,
    opts.images
      ? `The creator allows AI image generation. When a marker genuinely needs a picture that is not in the project library and cannot be drawn well in code (a photo, a realistic scene, a detailed illustration or character), set its "generateImage" to true and say in its prompt what the image should show and how the animation uses it. Each image costs time and money, so set it only where it clearly adds value, and never for text, numbers, charts, simple shapes or icons. Otherwise set it to false.`
      : null,
    `Respond with ONLY a JSON array, no prose, no markdown code fences, of objects shaped exactly like:\n[{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}${opts.library.length > 0 ? ', "assets": string[]' : ''}${opts.narration ? ', "narration": string' : ''}${opts.images ? ', "generateImage": boolean' : ''}}]`,
    `Rules: start/end are seconds within [0, ${opts.durationSeconds.toFixed(1)}]. ${area ? 'region is always null here; the chosen area is applied for you.' : 'region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1).'} No two proposed ranges may overlap each other or any existing marker listed above.`,
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

export async function planMarkers(id: string, context?: string, signal?: AbortSignal): Promise<PlanMarkersResult> {
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

  const { text, success, failure } = await withProjectLock(id, 'plan', () =>
    runClaudeHeadlessCapturingText({
      cwd: projectDir(id),
      prompt,
      tools: [],
      logContext: { project: id, purpose: 'plan-markers' },
      signal,
      onEvent: () => {},
    })
  );

  if (!success) throw new Error(failure?.message ?? 'Claude could not produce a plan.');
  const raw = extractJsonArray(text);
  const result = finalizeProposals(raw, id, durationSeconds, markers);
  // The video's own speech is the voice here; a voiceover is only planned from an idea, and so are AI images.
  for (const p of result.proposals) {
    p.narration = '';
    p.generateImage = false;
  }

  log('info', 'plan.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount });
  return result;
}

// With a region, every proposed marker is confined to it whatever Claude answered. With narration,
// each marker also gets a voiceover line. With images, Claude may mark markers that should get an
// image generated with AI.
export async function planMarkersFromIdea(
  id: string,
  idea: string,
  opts: { region?: MarkerRegion; narration?: boolean; images?: boolean } = {},
  signal?: AbortSignal
): Promise<PlanMarkersResult> {
  const { region, narration, images } = opts;
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
    region,
    narration,
    images,
  });

  const { text, success, failure } = await withProjectLock(id, 'plan', () =>
    runClaudeHeadlessCapturingText({
      cwd: projectDir(id),
      prompt,
      tools: [],
      logContext: { project: id, purpose: 'plan-markers-from-idea' },
      signal,
      onEvent: () => {},
    })
  );

  if (!success) throw new Error(failure?.message ?? 'Claude could not produce a plan.');
  const raw = extractJsonArray(text);
  const result = finalizeProposals(raw, id, durationSeconds, markers);
  for (const p of result.proposals) {
    if (region) p.region = region;
    if (!narration) p.narration = '';
    if (!images) p.generateImage = false;
  }

  log('info', 'plan-from-idea.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount });
  return result;
}
