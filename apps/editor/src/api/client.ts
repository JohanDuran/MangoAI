// In development the editor runs on the Vite server and talks to the runner directly. When the runner
// serves the built editor (the installed app), API calls are same-origin.
export const BASE: string = import.meta.env.DEV ? (import.meta.env.VITE_RUNNER_URL as string | undefined) ?? 'http://localhost:5175' : '';

// What the timeline is built on top of. Absent (or 'video') means the classic flow: an uploaded
// raw video drives preview/export. The others let a project exist with no uploaded video.
export type BaseLayer =
  | { type: 'video' }
  | { type: 'color'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'transparent' };

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  overlayVolume?: number;
  // Volume (0 to 1) of the voiceover; absent means 1.
  voiceVolume?: number;
  // The voice last picked for a voiceover line.
  voice?: string;
  autoDescribeImages?: boolean;
  baseLayer?: BaseLayer;
}

export interface CompositionConfig {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}

// Normalized 0-1 fractions of the composition canvas — resolution-independent. Absent on
// a Marker means the animation covers the full screen.
export interface MarkerRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Marker {
  marker_id: string;
  start: number;
  end: number;
  prompt: string;
  feedback: string;
  status: 'draft' | 'ready' | 'error';
  region?: MarkerRegion;
  // Ids of library images attached to this marker.
  assets?: string[];
  narration?: MarkerNarration;
}

// A spoken line played from the marker's start. audio is the generated speech and what it was
// made from; when that differs from text/voice, the speech is out of date and is not played.
export interface MarkerNarration {
  text: string;
  voice: string;
  audio?: { file: string; text: string; voice: string; durationSec: number };
}

// The speech that will actually play for a marker, if any.
// A marker is kept at least this much longer than its voice (narration.ts on the runner).
export const VOICE_TAIL_SEC = 0.2;

// The shortest a marker may be: its voice is never cut, so the marker must hold it.
export const minMarkerSeconds = (m: Marker) => {
  const audio = playableNarration(m);
  return audio ? audio.durationSec + VOICE_TAIL_SEC : 0;
};

export const playableNarration = (m: Marker) => {
  const n = m.narration;
  return n?.audio && n.audio.text === n.text && n.audio.voice === n.voice ? n.audio : null;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const listProjects = () => fetch(`${BASE}/projects`).then((r) => json<Project[]>(r));

export interface CreateProjectOptions {
  baseLayer?: BaseLayer;
  fps?: number;
  width?: number;
  height?: number;
  durationInFrames?: number;
}

export const createProject = (name: string, opts: CreateProjectOptions = {}) =>
  fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...opts }),
  }).then((r) => json<Project>(r));

export const deleteProject = (id: string) =>
  fetch(`${BASE}/projects/${id}`, { method: 'DELETE' }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  });

// Volume (0 to 1) of the sounds played by overlay animations; 0 mutes them. Used by the export.
export const saveOverlayVolume = (id: string, volume: number) =>
  fetch(`${BASE}/projects/${id}/overlay-volume`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume }),
  }).then((r) => json<{ volume: number }>(r));

export const saveVoiceVolume = (id: string, volume: number) =>
  fetch(`${BASE}/projects/${id}/voice-volume`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume }),
  }).then((r) => json<{ volume: number }>(r));

export interface VoiceOptions {
  voices: string[];
  defaultVoice: string;
  maxChars: number;
}

export const getVoices = () => fetch(`${BASE}/voices`).then((r) => json<VoiceOptions>(r));

// An error response's message, for showing to the user.
async function errorText(r: Response): Promise<string> {
  const body = await r.text();
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body || `${r.status} ${r.statusText}`;
  }
}

// Saves a marker's voiceover line (empty removes it). Does not generate the speech.
export const saveMarkerNarration = (id: string, markerId: string, text: string, voice: string) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}/narration`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(await errorText(r));
    return (await r.json()) as Marker;
  });

// Turns the saved line into speech with OpenAI (billed to the user's key; an unchanged line is reused).
export const generateMarkerNarration = (id: string, markerId: string) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}/narration/generate`, { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error(await errorText(r));
    return (await r.json()) as Marker;
  });

// A short sample of a voice (the first listen to each voice is a small OpenAI request).
export const getVoiceSample = (voice: string) =>
  fetch(`${BASE}/voices/${encodeURIComponent(voice)}/sample`).then(async (r) => {
    if (!r.ok) throw new Error(await errorText(r));
    return r.blob();
  });

export const narrationUrl = (id: string, file: string) => `${BASE}/projects/${id}/voice/${file}`;

export const getProject =(id: string) =>
  fetch(`${BASE}/projects/${id}`).then((r) =>
    json<{ project: Project; markers: Marker[]; hasVideo: boolean; composition: CompositionConfig; baseLayer: BaseLayer }>(r)
  );

export const videoUrl = (id: string) => `${BASE}/projects/${id}/video?t=${Date.now()}`;

export const uploadVideo = (id: string, file: File) => {
  const form = new FormData();
  form.append('video', file);
  return fetch(`${BASE}/projects/${id}/video`, { method: 'POST', body: form }).then((r) =>
    json<{ url: string; warnings?: string[]; info?: { width: number; height: number; durationSeconds: number; codec: string; hasAudio: boolean } }>(r)
  );
};

export const updateComposition = (id: string, patch: Partial<CompositionConfig>) =>
  fetch(`${BASE}/projects/${id}/composition`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => json<CompositionConfig>(r));

export const addMarker = (id: string, input: { start: number; end: number; prompt: string; region?: MarkerRegion; assets?: string[] }) =>
  fetch(`${BASE}/projects/${id}/markers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then((r) => json<Marker>(r));

export const getMarkerCode = (id: string, markerId: string) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}/code`).then((r) => r.text());

export const updateMarkerTiming = (id: string, markerId: string, timing: { start: number; end: number }) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(timing),
  }).then((r) => json<Marker>(r));

// Pass null to reset the marker to full screen.
export const updateMarkerRegion = (id: string, markerId: string, region: MarkerRegion | null) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}/region`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region }),
  }).then((r) => json<Marker>(r));

export const deleteMarker = (id: string, markerId: string) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}`, { method: 'DELETE' }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  });

export interface ExportStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: 'preparing' | 'bundling' | 'rendering' | 'mixing' | 'finishing' | null;
  percent: number;
  message: string;
  result?: {
    output?: string;
    outputDir?: string;
    outputs?: { markerId: string; file: string }[];
    // The voiceover written beside an overlay-only export.
    narration?: string;
    voices?: { markerId: string; file: string }[];
  };
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const getExportStatus = (id: string) => fetch(`${BASE}/projects/${id}/export/status`).then((r) => json<ExportStatus>(r));

export const cancelExport = (id: string) => fetch(`${BASE}/projects/${id}/export/cancel`, { method: 'POST' }).then(() => undefined);

// Starts an export and follows it until it finishes, reporting progress along the way. If the editor
// reloads mid-export, calling this again with resume=true picks the running export back up.
export async function exportProject(
  id: string,
  includeVideo: boolean,
  perMarker: boolean,
  onProgress: (status: ExportStatus) => void,
  resume = false
): Promise<ExportStatus> {
  if (!resume) {
    const started = await fetch(`${BASE}/projects/${id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeVideo, perMarker }),
    }).then((r) => json<ExportStatus>(r));
    onProgress(started);
  }
  let failures = 0;
  for (;;) {
    await sleep(700);
    try {
      const status = await getExportStatus(id);
      failures = 0;
      onProgress(status);
      if (status.state !== 'running') return status;
    } catch (err) {
      // The runner may be restarting; give it a moment before giving up on following the export.
      if (++failures >= 15) throw err;
    }
  }
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export const transcribeProject = (id: string) =>
  fetch(`${BASE}/projects/${id}/transcript`, { method: 'POST' }).then((r) => json<{ segments: TranscriptSegment[] }>(r));

export const getTranscript = (id: string) =>
  fetch(`${BASE}/projects/${id}/transcript`).then((r) => json<{ segments: TranscriptSegment[] }>(r));

// Saves manual edits to the transcript text (e.g. fixing a misheard word) without re-running Whisper.
export const updateTranscript = (id: string, segments: TranscriptSegment[]) =>
  fetch(`${BASE}/projects/${id}/transcript`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  }).then((r) => json<{ segments: TranscriptSegment[] }>(r));

export interface RegenerateEvent {
  event: string;
  data: unknown;
}

// Shared by every endpoint that streams Server-Sent Events over a POST response.
// EventSource can't do POST, so the stream is read manually and split on the SSE frame
// delimiter.
async function readEventStream(res: Response, onEvent: (e: RegenerateEvent) => void): Promise<void> {
  if (!res.body) throw new Error('No response stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (eventLine && dataLine) {
        onEvent({
          event: eventLine.slice('event: '.length),
          data: JSON.parse(dataLine.slice('data: '.length)),
        });
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

// The editor's "generate an image" checkbox opts this request into the image-generation skill.
const IMAGE_SKILLS = ['image-generation'];

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

// Aborting closes this browser's connection, which also stops the run on the runner (use stopWork
// to stop it and still get the final event). Aborting resolves quietly instead of throwing.
export async function regenerateMarker(
  id: string,
  markerId: string,
  feedback: string,
  allowImage: boolean,
  onEvent: (e: RegenerateEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/projects/${id}/markers/${markerId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback, allowSkills: allowImage ? IMAGE_SKILLS : [] }),
      signal,
    });
    await readEventStream(res, onEvent);
  } catch (err) {
    if (!isAbort(err)) throw err;
  }
}

export interface ProposedMarker {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  assets?: string[];
  narration?: string;
}

// A proposed marker as saved in the project's plan file, with the edits made while reviewing it.
export interface PlanItem {
  key: string;
  included: boolean;
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
  assets: string[];
  // Voiceover line spoken from the marker's start; absent or empty for none.
  narration?: string;
  // Set once applying the plan created a marker for this item.
  markerId?: string;
  // Why applying skipped this item, if it did.
  error?: string;
}

// region on an idea plan is the area every proposed marker was confined to; narration says whether
// Claude was asked for voiceover lines.
export type PlanSource = { kind: 'transcript'; context?: string } | { kind: 'idea'; idea: string; region?: MarkerRegion; narration?: boolean };

// Saved on the runner from the moment planning starts, so a crash or reload does not lose it.
export interface StoredPlan {
  state: 'planning' | 'review' | 'applying';
  source: PlanSource;
  createdAt: string;
  updatedAt: string;
  droppedCount: number;
  items: PlanItem[];
}

// Thrown when the user stopped the request.
export class StoppedError extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'StoppedError';
  }
}

const planResult = async (r: Response) => {
  if (r.status === 499) throw new StoppedError();
  return json<{ proposals: ProposedMarker[]; droppedCount: number; plan: StoredPlan }>(r);
};

// context is optional free-text steering (e.g. "use a line graph for the compound interest
// section") layered on top of the transcript the plan is otherwise based on.
export const planMarkers = (id: string, context?: string) =>
  fetch(`${BASE}/projects/${id}/markers/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  }).then(planResult);

// Without a region Claude picks each marker's area itself. With narration it also writes a
// voiceover line for each marker.
export const planMarkersFromIdea = (id: string, idea: string, opts: { region?: MarkerRegion; narration?: boolean } = {}) =>
  fetch(`${BASE}/projects/${id}/markers/plan-from-idea`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idea, region: opts.region, narration: opts.narration }),
  }).then(planResult);

// running lists the Claude work in progress for the project ('plan', 'apply', 'regenerate:<id>').
export const getPlan = (id: string) => fetch(`${BASE}/projects/${id}/plan`).then((r) => json<{ plan: StoredPlan | null; running: string[] }>(r));

export const savePlan = (id: string, items: PlanItem[]) =>
  fetch(`${BASE}/projects/${id}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }).then((r) => json<{ plan: StoredPlan }>(r));

export const discardPlan = (id: string) =>
  fetch(`${BASE}/projects/${id}/plan`, { method: 'DELETE' }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  });

// Stops Claude work on the runner: 'plan', 'apply', 'regenerate:<markerId>', or everything when omitted.
// A stopped generation puts back the marker's previous code, and markers a stopped plan apply had
// only half made are removed.
export const stopWork = (id: string, tag?: string) =>
  fetch(`${BASE}/projects/${id}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  }).then((r) => json<{ stopped: number }>(r));

export interface ApplyMarkerInput {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
  assets?: string[];
  narration?: string;
  // The saved plan item this comes from.
  key?: string;
  // A marker left unfinished by an interrupted earlier apply of this item.
  markerId?: string;
}

export async function applyMarkerPlan(
  id: string,
  markers: ApplyMarkerInput[],
  onEvent: (e: RegenerateEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    const res = await fetch(`${BASE}/projects/${id}/markers/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markers: markers.map(({ allowImage, ...m }) => ({ ...m, allowSkills: allowImage ? IMAGE_SKILLS : [] })) }),
      signal,
    });
    await readEventStream(res, onEvent);
  } catch (err) {
    if (!isAbort(err)) throw err;
  }
}

export interface Asset {
  id: string;
  file: string;
  name: string;
  kind: 'upload' | 'generated';
  width?: number;
  height?: number;
  bytes?: number;
  description?: string;
  // Filename of a small static preview; absent on assets uploaded before thumbnails existed.
  thumb?: string;
  createdAt: string;
}

export const assetFileUrl = (projectId: string, asset: Asset) => `${BASE}/projects/${projectId}/assets/${asset.file}`;

// The small preview used in grids (falls back to the full file for assets with no thumbnail).
export const assetThumbUrl = (projectId: string, asset: Asset) =>
  asset.thumb ? `${BASE}/projects/${projectId}/assets/${asset.thumb}` : assetFileUrl(projectId, asset);

export const listAssets = (id: string) => fetch(`${BASE}/projects/${id}/assets`).then((r) => json<Asset[]>(r));

export const uploadAsset = (id: string, file: File) => {
  const form = new FormData();
  form.append('image', file);
  return fetch(`${BASE}/projects/${id}/assets`, { method: 'POST', body: form }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
    }
    return r.json() as Promise<Asset>;
  });
};

export const updateAsset = (id: string, assetId: string, patch: { name?: string; description?: string }) =>
  fetch(`${BASE}/projects/${id}/assets/${assetId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => json<Asset>(r));

// Resolves with the ids of markers that still use the image when the server refuses to delete it.
export const deleteAsset = (id: string, assetId: string, force = false) =>
  fetch(`${BASE}/projects/${id}/assets/${assetId}${force ? '?force=1' : ''}`, { method: 'DELETE' }).then(async (r) => {
    if (r.status === 409) return { deleted: false as const, markers: ((await r.json()) as { markers: string[] }).markers };
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return { deleted: true as const, markers: [] as string[] };
  });

export const setMarkerAssets = (id: string, markerId: string, assets: string[]) =>
  fetch(`${BASE}/projects/${id}/markers/${markerId}/assets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assets }),
  }).then((r) => json<Marker>(r));

// Has Claude write the image's description (replacing an existing one only when overwrite is set).
export const describeAsset = (id: string, assetId: string, overwrite = false) =>
  fetch(`${BASE}/projects/${id}/assets/${assetId}/describe${overwrite ? '?overwrite=1' : ''}`, { method: 'POST' }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
    }
    return r.json() as Promise<Asset>;
  });

export const saveAutoDescribe = (id: string, autoDescribe: boolean) =>
  fetch(`${BASE}/projects/${id}/asset-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoDescribe }),
  }).then((r) => json<{ autoDescribe: boolean }>(r));

export type CheckState = 'ok' | 'warn' | 'error';

export interface StatusCheck {
  id: string;
  label: string;
  state: CheckState;
  summary: string;
  details?: string[];
  ms?: number;
}

export interface StatusSkill {
  name: string;
  origin: 'builtin' | 'external';
  description: string;
  optIn: boolean;
  hasTools: boolean;
  env: string[];
  missingEnv: string[];
}

export interface StatusReport {
  checkedAt: string;
  overall: CheckState;
  checks: StatusCheck[];
  skills: StatusSkill[];
  skillProblems: { folder: string; error: string }[];
}

export const getStatus = () => fetch(`${BASE}/status`).then((r) => json<StatusReport>(r));
