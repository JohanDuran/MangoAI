// App state: the open project (through a core Editor), resolved times, media lengths, selection, saving.
// Playhead time is NOT here (it changes 60×/s); views read it from the Player each frame.
import { Editor, OpError, WordIndex, type Change, type Clip, type Op, type Resolved, type Track, type Word } from '@mangoai/core';
import { useSyncExternalStore } from 'react';
import { api, peakArray, type ExportJob, type Opened, type ServerEvent } from './api';

export interface LoadedPeaks {
  rate: number;
  data: Int8Array;
  lufs: number | null;
}

/** One id per browser tab, so the server doesn't echo our own saves back to us. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 10);

export interface Picked {
  clip: string;
  selector?: string;
  id?: string;
  text?: string;
  /** In frame pixels. */
  box?: [number, number, number, number];
}

export class Studio {
  opened: Opened | null = null;
  editor: Editor | null = null;
  /** The first transcript as stored (source time). */
  rawWords: WordIndex | null = null;
  /** What `word:` links use: the first transcript as heard on the timeline. */
  get words(): WordIndex | null {
    return this.resolved()?.wordIndex ?? this.rawWords;
  }
  durations = new Map<string, number>();
  peaks = new Map<string, LoadedPeaks>();
  /** Selected clip ids; the last one is the primary (shown in the inspector). */
  selected: string[] = [];
  /** In/out range on the ruler (I / O, or shift-drag), for ripple delete and requests. */
  range: [number, number] | null = null;
  /** Box drawn on the viewer for a request, normalized 0-1. */
  region: [number, number, number, number] | null = null;
  /** The element picked inside a graphic (request mode). */
  picked: Picked | null = null;
  mode: 'edit' | 'request' = 'edit';
  error: string | null = null;
  notice: string | null = null;
  /** Unsaved edits found in .mangoai/draft.json when the project opened. */
  draftOffer = 0;
  loading = false;
  saving = false;
  /** Export cache per time span (phase 5): green on the timeline when rendered and current. */
  cachePlan: { t0: number; t1: number; cached: boolean }[] | null = null;
  exportJob: ExportJob | null = null;
  /** Bumped per comp clip when its files change, so previews reload ('*' = all). */
  compVersion = new Map<string, number>();
  private listeners = new Set<() => void>();
  private editListeners = new Set<() => void>();
  private ver = 0;
  private events: EventSource | null = null;
  private draftTimer = 0;
  private noticeTimer = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.ver;
  emit() {
    this.ver++;
    for (const fn of this.listeners) fn();
  }
  /** Called after every change to the timeline (edit, undo, Claude's save). */
  onEdit(fn: () => void) {
    this.editListeners.add(fn);
    return () => {
      this.editListeners.delete(fn);
    };
  }
  private edited() {
    for (const fn of this.editListeners) fn();
    this.selected = this.selected.filter((id) => this.editor?.clip(id));
    this.scheduleDraft();
    this.emit();
  }

  get selection(): string | null {
    return this.selected[this.selected.length - 1] ?? null;
  }

  get dirty(): boolean {
    return this.editor?.dirty ?? false;
  }

  async open(dir: string, keepView = false) {
    this.loading = true;
    this.error = null;
    this.emit();
    try {
      const opened = await api.open(dir);
      this.opened = opened;
      this.rawWords = opened.words ? new WordIndex(opened.words) : null;
      this.durations = new Map(
        Object.entries(opened.media)
          .filter(([, m]) => m.duration !== undefined && m.kind !== 'image')
          .map(([src, m]) => [src, m.duration!]),
      );
      this.editor = new Editor(opened.project, { ...(this.rawWords && { words: this.rawWords }), durations: this.durations, transcripts: opened.transcripts });
      this.editor.markSaved();
      if (!keepView) {
        this.selected = [];
        this.range = null;
        this.region = null;
        this.picked = null;
      }
      this.peaks.clear();
      void this.loadPeaks();
      remember(dir);
      this.listen(dir);
      this.draftOffer = opened.draft?.changes.length ?? 0;
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
        if (this.peaks.has(src)) return;
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

  // --- selection ------------------------------------------------------------------------------
  select(id: string | null, add = false) {
    if (id === null) this.selected = [];
    else if (add) this.selected = this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id];
    else this.selected = [id];
    this.reportSelection();
    this.emit();
  }

  setSelected(ids: string[]) {
    this.selected = ids;
    this.reportSelection();
    this.emit();
  }

  setRange(r: [number, number] | null) {
    this.range = r && Math.abs(r[1] - r[0]) > 0.01 ? [Math.min(r[0], r[1]), Math.max(r[0], r[1])] : null;
    this.reportSelection();
    this.emit();
  }

  setRegion(r: [number, number, number, number] | null) {
    this.region = r;
    this.reportSelection();
    this.emit();
  }

  setPicked(p: Picked | null) {
    this.picked = p;
    this.reportSelection();
    this.emit();
  }

  setMode(m: 'edit' | 'request') {
    this.mode = m;
    this.emit();
  }

  clip(id: string): { clip: Clip; track: Track } | null {
    const e = this.editor;
    const clip = e?.clip(id);
    const track = e?.trackOf(id);
    return clip && track ? { clip, track } : null;
  }

  /** Playhead, for the selection report (set by the App from the player). */
  playhead: () => number = () => 0;
  private selTimer = 0;
  /** Tell the server what's selected, so Claude's `selection` tool can see it (nothing is sent to Claude). */
  reportSelection() {
    clearTimeout(this.selTimer);
    this.selTimer = window.setTimeout(() => {
      const o = this.opened;
      if (!o) return;
      void api
        .post('/api/selection', {
          dir: o.dir,
          clips: this.selected,
          range: this.range,
          region: this.region,
          picked: this.picked,
          t: this.playhead(),
          dirty: this.dirty,
          unsaved: this.editor?.unsaved().flatMap((c) => c.summary) ?? [],
        })
        .catch(() => {});
    }, 250);
  }

  // --- editing --------------------------------------------------------------------------------
  /** Apply ops as one undoable change by you. Returns false (and shows why) if it was refused. */
  apply(ops: Op[], label?: string): boolean {
    const e = this.editor;
    if (!e || ops.length === 0) return false;
    try {
      e.apply(ops, { author: 'you', ...(label && { label }) });
      this.edited();
      return true;
    } catch (err) {
      this.flash((err as Error).message, true);
      return false;
    }
  }

  /** Build ops with a command; errors (e.g. a locked track) are shown instead of thrown. */
  run(make: (e: Editor) => Op[], label?: string): boolean {
    const e = this.editor;
    if (!e) return false;
    try {
      return this.apply(make(e), label);
    } catch (err) {
      this.flash((err as Error).message, true);
      return false;
    }
  }

  undo() {
    const c = this.editor?.undo();
    if (c) {
      this.flash(`Undid: ${c.label}`);
      this.edited();
    }
  }

  redo() {
    const c = this.editor?.redo();
    if (c) {
      this.flash(`Redid: ${c.label}`);
      this.edited();
    }
  }

  flash(msg: string, isError = false) {
    clearTimeout(this.noticeTimer);
    if (isError) this.error = msg;
    else this.notice = msg;
    this.emit();
    this.noticeTimer = window.setTimeout(() => {
      this.error = null;
      this.notice = null;
      this.emit();
    }, isError ? 7000 : 2500);
  }

  // --- saving ---------------------------------------------------------------------------------
  async save(): Promise<boolean> {
    const o = this.opened;
    const e = this.editor;
    if (!o || !e || this.saving) return false;
    const changes = e.unsaved();
    if (changes.length === 0 && o.from === 'cut.json') return true;
    this.saving = true;
    this.emit();
    try {
      const res = await api.save({
        dir: o.dir,
        client: CLIENT_ID,
        base: e.project.revision,
        changes: changes.map(slimChange),
        project: e.project,
      });
      e.project.revision = res.revision;
      e.markSaved();
      o.from = 'cut.json';
      this.draftOffer = 0;
      this.flash(`Saved revision ${res.revision}`);
      this.reportSelection();
      return true;
    } catch (err) {
      this.flash(`Save failed: ${(err as Error).message}`, true);
      return false;
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  private scheduleDraft() {
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      const o = this.opened;
      const e = this.editor;
      if (!o || !e) return;
      void api.post('/api/draft', { dir: o.dir, base: e.project.revision, changes: e.unsaved().map(slimChange) }).catch(() => {});
      this.reportSelection();
    }, 2000);
  }

  /** Re-apply the unsaved edits left in .mangoai/draft.json by a crashed or closed tab. */
  restoreDraft() {
    const d = this.opened?.draft;
    this.draftOffer = 0;
    if (!d || !this.editor) return this.emit();
    let ok = 0;
    for (const c of d.changes) {
      try {
        this.editor.apply(c.ops, { author: 'you', label: c.label });
        ok++;
      } catch {}
    }
    this.flash(`Restored ${ok} of ${d.changes.length} unsaved edits`);
    this.edited();
  }

  discardDraft() {
    this.draftOffer = 0;
    if (this.opened) void api.post('/api/draft', { dir: this.opened.dir, base: this.editor?.project.revision ?? 0, changes: [] }).catch(() => {});
    this.emit();
  }

  // --- live updates from the server (Claude's saves, comp edits, frame requests) -----------------
  private listen(dir: string) {
    this.events?.close();
    const es = new EventSource(`/api/events?dir=${encodeURIComponent(dir)}&client=${CLIENT_ID}`);
    this.events = es;
    es.onmessage = (m) => {
      try {
        void this.onServer(JSON.parse(m.data) as ServerEvent);
      } catch {}
    };
  }

  /** Set by the App: draws a frame and posts it back for Claude's `frame` tool. */
  frameHandler: ((t: number, id: string) => Promise<void>) | null = null;

  private async onServer(ev: ServerEvent) {
    const e = this.editor;
    const o = this.opened;
    if (!e || !o) return;
    switch (ev.type) {
      case 'saved': {
        if (ev.client === CLIENT_ID || ev.revision <= e.project.revision) return;
        const who = ev.author === 'claude' ? 'Claude' : 'Another window';
        if (ev.ops && ev.base === e.project.revision) {
          try {
            await this.refreshMedia(ev.ops);
            const { dropped } = e.rebase(ev.ops, { author: ev.author, label: ev.label });
            e.project.revision = ev.revision;
            this.flash(
              `${who} saved revision ${ev.revision}: ${ev.label}` +
                (dropped.length ? `. Kept out ${dropped.length} of your unsaved edits that no longer fit: ${dropped.map((d) => d.label).join('; ')}` : ''),
              dropped.length > 0,
            );
            this.edited();
            return;
          } catch (err) {
            if (!(err instanceof OpError)) console.error(err);
          }
        }
        // can't replay: reload from disk, then put our unsaved edits back on top
        const local = e.unsaved();
        await this.open(o.dir, true);
        const ed2 = this.editor;
        let kept = 0;
        if (ed2)
          for (const c of local) {
            try {
              ed2.apply(c.ops, { author: 'you', label: c.label });
              kept++;
            } catch {}
          }
        this.flash(`${who} saved revision ${ev.revision}; reloaded${local.length ? `, re-applied ${kept} of ${local.length} unsaved edits` : ''}`);
        this.edited();
        return;
      }
      case 'comp-changed':
        this.compVersion.set(ev.clip ?? '*', Date.now());
        for (const fn of this.editListeners) fn();
        this.emit();
        return;
      case 'words-changed': {
        const w = await api.words(o.dir);
        if (w.words) {
          this.rawWords = new WordIndex(w.words);
          o.words = w.words;
          o.transcripts = w.transcripts;
          this.editor = rebuildEditor(e, this.rawWords, this.durations, w.transcripts);
          this.flash('The transcript changed: word-linked clips moved with it');
          this.edited();
        }
        return;
      }
      case 'export':
        this.exportJob = ev.job;
        this.emit();
        return;
      case 'frame':
        if (this.frameHandler && ev.id !== undefined && ev.t !== undefined) await this.frameHandler(ev.t, ev.id);
        return;
    }
  }

  /** Probe media that ops refer to and we haven't seen yet (Claude added a clip). */
  private async refreshMedia(ops: Op[]) {
    const o = this.opened;
    if (!o) return;
    const missing = new Set<string>();
    for (const op of ops) {
      const clips = op.op === 'add_clip' ? [op.clip] : op.op === 'add_track' ? op.track.clips : [];
      for (const c of clips) {
        if (c.type === 'media' && !o.media[c.src]) missing.add(c.src);
        if (c.type === 'generator' && typeof c.params.image === 'string' && !o.media[c.params.image]) missing.add(c.params.image);
      }
      if (op.op === 'update_clip' && typeof op.set.src === 'string' && !o.media[op.set.src]) missing.add(op.set.src);
    }
    if (!missing.size) return;
    await this.probe([...missing]);
  }

  async probe(srcs: string[]) {
    const o = this.opened!;
    const m = await api.media(o.dir, srcs);
    Object.assign(o.media, m.media);
    for (const [src, info] of Object.entries(m.media)) if (info.duration !== undefined && info.kind !== 'image') this.durations.set(src, info.duration);
    void this.loadPeaks();
  }

  /** Media pool path → a clip src (relative to the project folder when inside it). */
  srcOf(path: string): string {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const d = norm(this.opened?.dir ?? '').replace(/\/$/, '');
    const p = norm(path);
    return p.toLowerCase().startsWith(d.toLowerCase() + '/') ? p.slice(d.length + 1) : p;
  }
}

/** A new Editor over the same project (after the transcript changed), keeping the unsaved edits. */
function rebuildEditor(old: Editor, words: WordIndex, durations: Map<string, number>, transcripts: Record<string, Word[]>): Editor {
  const unsaved = old.unsaved();
  for (let i = 0; i < unsaved.length; i++) old.undo();
  const ed = new Editor(old.project, { words, durations, transcripts });
  ed.markSaved();
  for (const c of unsaved) {
    try {
      ed.apply(c.ops, { author: c.author, label: c.label });
    } catch {}
  }
  return ed;
}

function slimChange(c: Change) {
  return { author: c.author, label: c.label, ops: c.ops, summary: c.summary, at: c.at };
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
