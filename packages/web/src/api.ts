import type { Author, Op, Project, Word } from '@mangoai/core';

export interface MediaInfo {
  path: string;
  kind: 'video' | 'audio' | 'image' | 'other';
  exists: boolean;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  playable?: boolean;
  url: string;
}

export interface SlimChange {
  author: Author;
  label: string;
  ops: Op[];
  summary: string[];
  at: string;
}

export interface Opened {
  dir: string;
  name: string;
  from: 'cut.json' | 'short.json';
  project: Project;
  words: Word[] | null;
  /** Every transcript's words (source time), by name. */
  transcripts: Record<string, Word[]>;
  /** By clip `src` as written in the project. */
  media: Record<string, MediaInfo>;
  /** Unsaved edits a previous tab left behind. */
  draft: { base: number; changes: SlimChange[]; at: string } | null;
  /** Comp clip id → URL of its live preview page. */
  comps: Record<string, string>;
}

export type ServerEvent =
  | { type: 'saved'; revision: number; base: number; author: Author; label: string; ops?: Op[]; client?: string }
  | { type: 'comp-changed'; clip?: string }
  | { type: 'words-changed' }
  | { type: 'frame'; id?: string; t?: number }
  | { type: 'export'; job: ExportJob }
  | { type: 'hello' };

export interface ExportJob {
  id: string;
  state: 'planning' | 'rendering' | 'done' | 'failed';
  progress: number;
  message: string;
  output?: string;
  error?: string;
  /** Seconds it took. */
  took?: number;
  reused?: number;
  rendered?: number;
}

export interface Peaks {
  rate: number;
  duration: number;
  lufs: number | null;
  data: string;
}

export interface PoolFile {
  path: string;
  rel: string;
  kind: string;
  size: number;
}

export interface Browse {
  dir: string;
  parent: string | null;
  folders: { name: string; path: string; project: boolean }[];
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  return body;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `${r.status} ${r.statusText}`);
  return out;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  open: (dir: string) => get<Opened>(`/api/open?${q({ dir })}`),
  pool: (dir: string) => get<{ dir: string; files: PoolFile[] }>(`/api/pool?${q({ dir })}`),
  browse: (dir?: string) => get<Browse>(`/api/browse${dir ? `?${q({ dir })}` : ''}`),
  peaks: (path: string, dir: string) => get<Peaks>(`/api/peaks?${q({ path, dir })}`),
  words: (dir: string) => get<{ words: Word[] | null; transcripts: Record<string, Word[]> }>(`/api/words?${q({ dir })}`),
  media: (dir: string, srcs: string[]) => post<{ media: Record<string, MediaInfo> }>('/api/media', { dir, srcs }),
  save: (body: { dir: string; client: string; base: number; changes: SlimChange[]; project: Project }) => post<{ revision: number }>('/api/save', body),
  fileUrl: (path: string, dir: string) => `/api/file?${q({ path, dir })}`,
  post,
  get,
};

/** Decode base64 Int8 peak pairs. */
export function peakArray(p: Peaks): Int8Array {
  const bin = atob(p.data);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}
