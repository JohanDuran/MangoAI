export const BASE = 'http://localhost:5175';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
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
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const listProjects = () => fetch(`${BASE}/projects`).then((r) => json<Project[]>(r));

export const createProject = (name: string) =>
  fetch(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<Project>(r));

export const deleteProject = (id: string) =>
  fetch(`${BASE}/projects/${id}`, { method: 'DELETE' }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  });

export const getProject =(id: string) =>
  fetch(`${BASE}/projects/${id}`).then((r) =>
    json<{ project: Project; markers: Marker[]; hasVideo: boolean; composition: CompositionConfig }>(r)
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

export const addMarker = (id: string, input: { start: number; end: number; prompt: string; region?: MarkerRegion }) =>
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

export const exportProject = (id: string, includeVideo = false) =>
  fetch(`${BASE}/projects/${id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeVideo }),
  }).then((r) => json<{ success: boolean; output?: string; log?: string }>(r));

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export const transcribeProject = (id: string) =>
  fetch(`${BASE}/projects/${id}/transcript`, { method: 'POST' }).then((r) => json<{ segments: TranscriptSegment[] }>(r));

export const getTranscript = (id: string) =>
  fetch(`${BASE}/projects/${id}/transcript`).then((r) => json<{ segments: TranscriptSegment[] }>(r));

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

export async function regenerateMarker(
  id: string,
  markerId: string,
  feedback: string,
  allowImage: boolean,
  onEvent: (e: RegenerateEvent) => void
): Promise<void> {
  const res = await fetch(`${BASE}/projects/${id}/markers/${markerId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback, allowSkills: allowImage ? IMAGE_SKILLS : [] }),
  });
  await readEventStream(res, onEvent);
}

export interface ProposedMarker {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
}

export const planMarkers = (id: string) =>
  fetch(`${BASE}/projects/${id}/markers/plan`, { method: 'POST' }).then((r) =>
    json<{ proposals: ProposedMarker[]; droppedCount: number }>(r)
  );

export interface ApplyMarkerInput {
  start: number;
  end: number;
  prompt: string;
  region: MarkerRegion | null;
  allowImage: boolean;
}

export async function applyMarkerPlan(
  id: string,
  markers: ApplyMarkerInput[],
  onEvent: (e: RegenerateEvent) => void
): Promise<void> {
  const res = await fetch(`${BASE}/projects/${id}/markers/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markers: markers.map(({ allowImage, ...m }) => ({ ...m, allowSkills: allowImage ? IMAGE_SKILLS : [] })) }),
  });
  await readEventStream(res, onEvent);
}
