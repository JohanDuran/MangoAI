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

export interface Marker {
  marker_id: string;
  start: number;
  end: number;
  prompt: string;
  feedback: string;
  status: 'draft' | 'ready' | 'error';
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

export const getProject = (id: string) =>
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

export const addMarker = (id: string, input: { start: number; end: number; prompt: string }) =>
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

export const exportProject = (id: string) =>
  fetch(`${BASE}/projects/${id}/export`, { method: 'POST' }).then((r) => json<{ success: boolean; output?: string; log?: string }>(r));

export interface RegenerateEvent {
  event: string;
  data: unknown;
}

// The regenerate endpoint streams Server-Sent Events over a POST response. EventSource
// can't do POST, so we read the stream manually and split on the SSE frame delimiter.
export async function regenerateMarker(
  id: string,
  markerId: string,
  feedback: string,
  onEvent: (e: RegenerateEvent) => void
): Promise<void> {
  const res = await fetch(`${BASE}/projects/${id}/markers/${markerId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  });
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
