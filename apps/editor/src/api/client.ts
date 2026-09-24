export const BASE = 'http://localhost:5175';

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
}

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

export const getProject =(id: string) =>
  fetch(`${BASE}/projects/${id}`).then((r) =>
    json<{ project: Project; markers: Marker[]; hasVideo: boolean; composition: CompositionConfig; baseLayer: BaseLayer }>(r)
  );

export const videoUrl = (id: string) => `${BASE}/projects/${id}/video?t=${Date.now()}`;

export const uploadVideo = (id: string, file: File) => {
  const form = new FormData();
  form.append('video', file);
  return fetch(`${BASE}/projects/${id}/video`, { method: 'POST', body: form }).then((r) =>
    json<{ url: string }>(r)
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

export const exportProject = (id: string, includeVideo = false, perMarker = false) =>
  fetch(`${BASE}/projects/${id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeVideo, perMarker }),
  }).then((r) =>
    json<{
      success: boolean;
      output?: string;
      outputDir?: string;
      outputs?: { markerId: string; file: string }[];
      log?: string;
    }>(r)
  );

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

// Aborting only closes this browser's connection; a generation already running on the runner
// carries on and saves its result. Aborting resolves quietly instead of throwing.
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
}

// context is optional free-text steering (e.g. "use a line graph for the compound interest
// section") layered on top of the transcript the plan is otherwise based on.
export const planMarkers = (id: string, context?: string) =>
  fetch(`${BASE}/projects/${id}/markers/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  }).then((r) => json<{ proposals: ProposedMarker[]; droppedCount: number }>(r));

export const planMarkersFromIdea = (id: string, idea: string) =>
  fetch(`${BASE}/projects/${id}/markers/plan-from-idea`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idea }),
  }).then((r) => json<{ proposals: ProposedMarker[]; droppedCount: number }>(r));

export interface ApplyMarkerInput {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
  assets?: string[];
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
