import { projectDir } from './paths.js';
import { readMarkers, isValidRegion, type MarkerRegion } from './markers.js';
import { readTranscript, type TranscriptSegment } from './transcript.js';
import { readCompositionConfig } from './composition.js';
import { runClaudeHeadlessCapturingText } from './claude.js';

export interface ProposedMarker {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
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
}): string {
  const transcriptLines = opts.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
  const existingLines =
    opts.existing.length > 0
      ? opts.existing.map((m) => `- [${m.start.toFixed(1)}-${m.end.toFixed(1)}] ${m.prompt}`).join('\n')
      : '(none)';

  return [
    `You are planning on-screen animated overlays for a video, based on its transcript. The video is ${opts.width}x${opts.height}px and ${opts.durationSeconds.toFixed(1)} seconds long.`,
    `Transcript (seconds, one segment per line):\n${transcriptLines}`,
    `Markers that already exist — do not propose anything overlapping these time ranges:\n${existingLines}`,
    `Decide where an animated overlay would meaningfully support what's being said (e.g. calling out a key stat, highlighting a quote, illustrating a concept) — do not propose one for every segment, only where it adds value. For each, decide a time range, a short creative-intent description of what the animation should show (this is handed to another agent to actually build it, so be concrete about content, not visual style minutiae), and whether it should be confined to a sub-area of the screen or use the full screen.`,
    `Respond with ONLY a JSON array, no prose, no markdown code fences, of objects shaped exactly like:\n[{"start": number, "end": number, "prompt": string, "region": null | {"x": number, "y": number, "width": number, "height": number}}]`,
    `Rules: start/end are seconds within [0, ${opts.durationSeconds.toFixed(1)}]. region is null for full screen, or x/y/width/height as fractions of the canvas between 0 and 1 (x+width <= 1, y+height <= 1). No two proposed ranges may overlap each other or any existing marker listed above.`,
  ].join('\n\n');
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

function normalizeCandidate(item: unknown): ProposedMarker | null {
  if (!item || typeof item !== 'object') return null;
  const { start, end, prompt, region } = item as Record<string, unknown>;
  if (typeof start !== 'number' || typeof end !== 'number' || typeof prompt !== 'string' || !prompt.trim()) return null;
  if (region !== null && region !== undefined && !isValidRegion(region)) return null;
  return { start, end, prompt: prompt.trim(), region: region ? (region as MarkerRegion) : null };
}

export async function planMarkers(id: string): Promise<PlanMarkersResult> {
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
  });

  const { text } = await runClaudeHeadlessCapturingText({
    projectId: id,
    cwd: projectDir(id),
    prompt,
    allowedTools: [],
    onEvent: () => {},
  });

  const raw = extractJsonArray(text);

  const proposals: ProposedMarker[] = [];
  let droppedCount = 0;
  for (const item of raw) {
    const candidate = normalizeCandidate(item);
    if (
      candidate &&
      isValidRange(candidate, durationSeconds) &&
      !overlapsAny(candidate, markers) &&
      !overlapsAny(candidate, proposals)
    ) {
      proposals.push(candidate);
    } else {
      droppedCount++;
    }
  }

  return { proposals, droppedCount };
}
