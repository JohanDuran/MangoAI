import type { Project, Word } from '@mangoai/core';

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

export interface Opened {
  dir: string;
  name: string;
  from: 'cut.json' | 'short.json';
  project: Project;
  words: Word[] | null;
  /** By clip `src` as written in the project. */
  media: Record<string, MediaInfo>;
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

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  open: (dir: string) => get<Opened>(`/api/open?${q({ dir })}`),
  pool: (dir: string) => get<{ dir: string; files: PoolFile[] }>(`/api/pool?${q({ dir })}`),
  browse: (dir?: string) => get<Browse>(`/api/browse${dir ? `?${q({ dir })}` : ''}`),
  peaks: (path: string, dir: string) => get<Peaks>(`/api/peaks?${q({ path, dir })}`),
  fileUrl: (path: string, dir: string) => `/api/file?${q({ path, dir })}`,
};

/** Decode base64 Int8 peak pairs. */
export function peakArray(p: Peaks): Int8Array {
  const bin = atob(p.data);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}
