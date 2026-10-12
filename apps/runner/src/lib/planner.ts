import { projectDir } from './paths.js';
import { readMarkers, isValidRegion, type MarkerRegion } from './markers.js';
import { readTranscript, type TranscriptSegment } from './transcript.js';
import { readCompositionConfig } from './composition.js';
import { runClaudeHeadlessCapturingText, withProjectLock } from './claude.js';
import { log } from './log.js';
import { readAssets, validAssetIds, type Asset } from './assets.js';
import { MAX_NARRATION_CHARS } from './narration.js';
import { lengthIsFixed } from './timeline.js';

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
  // Answers that could not become a marker at all (no description or no times).
  droppedCount: number;
  // Markers retimed to play one after another instead of overlapping, or to fit inside the video.
  movedCount: number;
  // The look every marker of the plan shares, so the video looks consistent; empty if none came back.
  look: string;
}

interface TimeRange {
  start: number;
  end: number;
}

// A marker as Claude answered it, before it is lined up with the others.
export interface Candidate extends ProposedMarker {
  // Meant to be on screen together with another marker (a caption over a scene, say), so it keeps
  // its place next to that marker instead of being moved after it.
  overlapsOnPurpose: boolean;
}

const EPSILON = 0.01;
const round = (n: number) => Math.round(n * 100) / 100;
// What a marker is given when Claude's end is not after its start.
const FALLBACK_SECONDS = 3;

// Prompt lines shared by the planners and the idea chat (ideaChat.ts).
export const existingMarkerLines = (existing: { start: number; end: number; prompt: string }[]): string =>
  existing.length > 0 ? existing.map((m) => `- [${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.prompt}`).join('\n') : '(none)';

export const libraryAssetLines = (library: Asset[]): string =>
  library
    .map((a) => `- id ${a.id}: "${a.name}"${a.width && a.height ? ` (${a.width}x${a.height})` : ''} — ${a.description ?? 'no description, so only use it if the name makes its content obvious'}`)
    .join('\n');

export const areaInPixels = (area: MarkerRegion, width: number, height: number): string =>
  `${Math.round(area.width * width)}x${Math.round(area.height * height)}px with its top-left corner at (${Math.round(area.x * width)}, ${Math.round(area.y * height)})`;

const LOOK_INSTRUCTION =
  '"look" is one short paragraph describing the visual style every marker shares, so the whole video looks consistent: background treatment, a color palette as hex codes, font family and weights, text sizes relative to the area, corner radii, and the motion style (easing, how things enter and leave). Every marker is built by a separate agent from its own prompt plus this look.';

const OVERLAP_RULE =
  'Markers play one after another: no two ranges may overlap each other or an existing marker, unless two markers are meant to be on screen at the same time (for example a caption over a scene). Then set "overlapsOnPurpose": true on the one that joins the other; such overlaps are kept as planned. Any other overlap is resolved by moving the later marker after the earlier one.';

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
    `Markers that already exist:\n${existingLines}`,
    opts.context
      ? `Instructions from the creator — follow these closely; they take priority over whatever you'd otherwise infer from the transcript alone:\n${opts.context}`
      : null,
    `Decide where an animated overlay would meaningfully support what's being said (e.g. calling out a key stat, highlighting a quote, illustrating a concept) — do not propose one for every segment, only where it adds value. For each, decide a time range, a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae), and whether it should be confined to a sub-area of the screen or use the full screen.`,
    opts.library.length > 0
      ? `The user uploaded these images to the project library:\n${libraryLines}\nWhen an image clearly belongs to a marker (for example a logo when that brand is mentioned, or a screenshot of the thing being discussed), list its id in that marker's "assets" array and write the prompt so it says how the image fits. Most markers need no image; never invent ids and never attach an image just to use it.`
      : null,
    LOOK_INSTRUCTION,
    `Respond with ONLY a JSON object, no prose, no markdown code fences, shaped exactly like:\n{"look": string, "markers": [{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}${opts.library.length > 0 ? ', "assets": string[]' : ''}, "overlapsOnPurpose": boolean}]}`,
    `Rules: start/end are seconds within [0, ${opts.durationSeconds.toFixed(1)}], timed to what is said. region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1). ${OVERLAP_RULE}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

// The planner's answer: {"look", "markers"}, or a bare list of markers from an answer that skipped the look.
function extractPlan(text: string): { look: string; items: unknown[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const between = (open: string, close: string) => {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
  };
  for (const candidate of [text.trim(), fenced?.trim(), between('{', '}'), between('[', ']')]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (Array.isArray(value)) return { look: '', items: value };
      const plan = value as { look?: unknown; markers?: unknown };
      if (plan && Array.isArray(plan.markers)) return { look: typeof plan.look === 'string' ? plan.look.trim() : '', items: plan.markers };
    } catch {
      // try the next strategy
    }
  }
  throw new Error(`Planner response was not a parseable plan: ${text.slice(0, 300)}`);
}

// Anything that has a description and times becomes a marker: a bad area falls back to full screen,
// and a start or end Claude got wrong is repaired rather than the marker thrown away.
function normalizeCandidate(item: unknown, projectId: string): Candidate | null {
  if (!item || typeof item !== 'object') return null;
  const { start, end, prompt, region, assets, narration, generateImage, overlapsOnPurpose } = item as Record<string, unknown>;
  if (typeof start !== 'number' || !Number.isFinite(start) || typeof prompt !== 'string' || !prompt.trim()) return null;
  const from = round(Math.max(0, start));
  const to = typeof end === 'number' && Number.isFinite(end) && end > from + EPSILON ? round(end) : round(from + FALLBACK_SECONDS);
  return {
    start: from,
    end: to,
    prompt: prompt.trim(),
    region: isValidRegion(region) ? region : null,
    assets: validAssetIds(projectId, assets),
    narration: typeof narration === 'string' ? narration.trim().slice(0, MAX_NARRATION_CHARS) : '',
    generateImage: generateImage === true,
    overlapsOnPurpose: overlapsOnPurpose === true,
  };
}

const overlap = (a: TimeRange, b: TimeRange) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

// Lines the markers up so they play one after another: each overlapping marker moves to start when
// the one in its way ends, keeping its length, which can push it past the end of the video (the
// timeline then grows, see timeline.ts). A marker that overlaps on purpose moves along with the
// marker it was planned to join, so the pair stays together. Nothing is dropped.
export function sequenceProposals(candidates: Candidate[], existing: TimeRange[]): { proposals: ProposedMarker[]; movedCount: number } {
  const ordered = [...candidates].sort((a, b) => a.start - b.start);
  const shifts = new Map<Candidate, number>();
  const taken: TimeRange[] = [...existing];
  for (const c of ordered.filter((c) => !c.overlapsOnPurpose)) {
    const length = c.end - c.start;
    let start = c.start;
    for (;;) {
      const blocking = taken.filter((r) => overlap({ start, end: start + length }, r) > EPSILON);
      if (blocking.length === 0) break;
      start = Math.max(...blocking.map((r) => r.end));
    }
    shifts.set(c, round(start - c.start));
    taken.push({ start: round(start), end: round(start + length) });
  }
  for (const c of ordered.filter((c) => c.overlapsOnPurpose)) {
    let partner: Candidate | null = null;
    for (const other of ordered) {
      if (other.overlapsOnPurpose || overlap(c, other) <= EPSILON) continue;
      if (!partner || overlap(c, other) > overlap(c, partner)) partner = other;
    }
    shifts.set(c, partner ? shifts.get(partner) ?? 0 : 0);
  }
  let movedCount = 0;
  const proposals = ordered.map((c) => {
    const shift = shifts.get(c) ?? 0;
    if (shift > EPSILON) movedCount++;
    const { overlapsOnPurpose: _onPurpose, ...marker } = c;
    return { ...marker, start: round(c.start + shift), end: round(c.end + shift) };
  });
  return { proposals, movedCount };
}

// On an uploaded video the length is fixed: when lining the markers up pushed the last ones past
// the end, the planned span is compressed (starts, ends and gaps alike) to end with the video.
export function fitProposalsToLength(proposals: ProposedMarker[], lengthSeconds: number): ProposedMarker[] {
  if (proposals.length === 0) return proposals;
  const last = Math.max(...proposals.map((p) => p.end));
  if (last <= lengthSeconds + EPSILON) return proposals;
  const first = Math.min(...proposals.map((p) => p.start));
  // Keep where the plan starts when there is room after it; otherwise use the whole video.
  const from = first < lengthSeconds * 0.5 ? first : 0;
  const scale = (lengthSeconds - from) / (last - from);
  const at = (t: number) => round(from + (t - from) * scale);
  return proposals.map((p) => ({ ...p, start: at(p.start), end: Math.min(at(p.end), round(lengthSeconds)) }));
}

function buildIdeaPlanPrompt(opts: {
  idea: string;
  durationSeconds: number;
  // An uploaded video's length is fixed; a blank canvas's is only a guide and grows to fit.
  fixedLength: boolean;
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
    `Break the idea into a sequence of multiple correlated markers that together cover the video from 0s to ${opts.durationSeconds.toFixed(1)}s — do not propose just one marker. Think of it as a storyboard: decide how many distinct beats the idea needs, order them narratively, and space them across the full duration so the video isn't front-loaded with content and empty afterward. Consecutive markers may sit back-to-back. ${opts.fixedLength ? `The length is fixed by the uploaded video: every marker must end by ${opts.durationSeconds.toFixed(1)}s.` : 'The length is only a guide for this blank canvas: if the brief truly needs more time, let the last markers run past it rather than cramming them; the canvas grows to fit.'}`,
    `Markers that already exist:\n${existingLines}`,
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
    `${LOOK_INSTRUCTION} Base it on the look and tone the brief describes.`,
    `Respond with ONLY a JSON object, no prose, no markdown code fences, shaped exactly like:\n{"look": string, "markers": [{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}${opts.library.length > 0 ? ', "assets": string[]' : ''}${opts.narration ? ', "narration": string' : ''}${opts.images ? ', "generateImage": boolean' : ''}, "overlapsOnPurpose": boolean}]}`,
    `Rules: start/end are seconds from 0${opts.fixedLength ? ` to ${opts.durationSeconds.toFixed(1)}` : ''}. ${area ? 'region is always null here; the chosen area is applied for you.' : 'region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1).'} ${OVERLAP_RULE}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

// fixedLength is the video's length in seconds when the project is built on an uploaded video.
function finalizeProposals(text: string, id: string, existing: TimeRange[], fixedLength?: number): PlanMarkersResult {
  const { look, items } = extractPlan(text);
  const candidates: Candidate[] = [];
  let droppedCount = 0;
  for (const item of items) {
    const candidate = normalizeCandidate(item, id);
    if (candidate) candidates.push(candidate);
    else droppedCount++;
  }
  const sequenced = sequenceProposals(candidates, existing);
  if (fixedLength === undefined) return { proposals: sequenced.proposals, droppedCount, movedCount: sequenced.movedCount, look };
  const fitted = fitProposalsToLength(sequenced.proposals, fixedLength);
  // Both lists are in start order (see sequenceProposals), so they line up item by item.
  const asPlanned = [...candidates].sort((a, b) => a.start - b.start);
  const changed = (p: ProposedMarker, i: number) => Math.abs(p.start - asPlanned[i].start) > EPSILON || Math.abs(p.end - asPlanned[i].end) > EPSILON;
  const movedCount = fitted.filter(changed).length;
  return { proposals: fitted, droppedCount, movedCount, look };
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
  const result = finalizeProposals(text, id, markers, lengthIsFixed(id) ? durationSeconds : undefined);
  // The video's own speech is the voice here; a voiceover is only planned from an idea, and so are AI images.
  for (const p of result.proposals) {
    p.narration = '';
    p.generateImage = false;
  }

  log('info', 'plan.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount, moved: result.movedCount });
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

  const fixedLength = lengthIsFixed(id);
  const prompt = buildIdeaPlanPrompt({
    idea: trimmedIdea,
    durationSeconds,
    fixedLength,
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
  const result = finalizeProposals(text, id, markers, fixedLength ? durationSeconds : undefined);
  for (const p of result.proposals) {
    if (region) p.region = region;
    if (!narration) p.narration = '';
    if (!images) p.generateImage = false;
  }

  log('info', 'plan-from-idea.done', { project: id, proposed: result.proposals.length, dropped: result.droppedCount, moved: result.movedCount });
  return result;
}
