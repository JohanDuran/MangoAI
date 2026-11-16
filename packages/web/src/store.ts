// App state: the open project (through a core Editor), resolved times, media lengths, selection.
// Playhead time is NOT here (it changes 60×/s); views read it from the Player each frame.
import { Editor, WordIndex, type Clip, type Resolved, type Track } from '@mangoai/core';
import { useSyncExternalStore } from 'react';
import { api, peakArray, type Opened } from './api';

export interface LoadedPeaks {
  rate: number;
  data: Int8Array;
  lufs: number | null;
}

export class Studio {
  opened: Opened | null = null;
  editor: Editor | null = null;
  words: WordIndex | null = null;
  durations = new Map<string, number>();
  peaks = new Map<string, LoadedPeaks>();
  selection: string | null = null;
  error: string | null = null;
  loading = false;
  private listeners = new Set<() => void>();
  private ver = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.ver;
  emit() {
    this.ver++;
    for (const fn of this.listeners) fn();
  }

  async open(dir: string) {
    this.loading = true;
    this.error = null;
    this.emit();
    try {
      const opened = await api.open(dir);
      this.opened = opened;
      this.words = opened.words ? new WordIndex(opened.words) : null;
      this.durations = new Map(
        Object.entries(opened.media)
          .filter(([, m]) => m.duration !== undefined && m.kind !== 'image')
          .map(([src, m]) => [src, m.duration!]),
      );
      this.editor = new Editor(opened.project, { ...(this.words && { words: this.words }), durations: this.durations });
      this.selection = null;
      this.peaks.clear();
      void this.loadPeaks();
      remember(dir);
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  private async loadPeaks() {
    const o = this.opened;
    if (!o) return;
    const audioSrcs = new Set<string>();
    for (const t of o.project.tracks) if (t.kind === 'audio') for (const c of t.clips) if (c.type === 'media') audioSrcs.add(c.src);
    await Promise.all(
      [...audioSrcs].map(async (src) => {
        const m = o.media[src];
        if (!m?.exists) return;
        try {
          const p = await api.peaks(m.path, o.dir);
          if (this.opened !== o) return;
          this.peaks.set(src, { rate: p.rate, data: peakArray(p), lufs: p.lufs });
          this.emit();
        } catch {}
      }),
    );
  }

  resolved(): Resolved | null {
    return this.editor?.resolve() ?? null;
  }

  select(id: string | null) {
    this.selection = id;
    this.emit();
  }

  clip(id: string): { clip: Clip; track: Track } | null {
    const e = this.editor;
    const clip = e?.clip(id);
    const track = e?.trackOf(id);
    return clip && track ? { clip, track } : null;
  }
}

export const studio = new Studio();

export function useStudio(): Studio {
  useSyncExternalStore(studio.subscribe, studio.snapshot);
  return studio;
}

const RECENT = 'mangoai.recent';

function remember(dir: string) {
  try {
    const list = recent().filter((d) => d !== dir);
    localStorage.setItem(RECENT, JSON.stringify([dir, ...list].slice(0, 8)));
  } catch {}
}

export function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[];
  } catch {
    return [];
  }
}
