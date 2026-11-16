// Live playback: an AudioContext is the master clock; video elements and the canvas follow it.
// Nothing is rendered to a file. Short audio (SFX, music, a Short's narration) is decoded into buffers
// and scheduled sample-accurately; long audio (a 50-min voice track) streams through a media element.
import type { Clip, CompClip, MediaClip, Project, Resolved, TitleClip } from '@mangoai/core';
import type { Opened, MediaInfo } from '../api';
import { TimelineIndex, type Span } from './index';
import { captionGroups, cardGeometry, color, drawCaption, drawTitle, findGroup, titleLayer, type CaptionGroup } from './look';

const LONG_AUDIO = 120; // seconds: longer files stream instead of being decoded whole
const PREROLL = 1.5; // seconds: video elements for upcoming clips are made and seeked this early
const DRIFT = 0.02; // seconds of drift tolerated before nudging the video's speed
const HARD_DRIFT = 0.6;
const PREROLL_PLAY = 0.8; // seconds before a cut that the next clip starts playing // seconds of drift before re-seeking outright

const dbToGain = (db: number) => Math.pow(10, db / 20);

interface VideoSlot {
  el: HTMLVideoElement;
  clipId: string;
  ready: boolean;
}

interface CompSlot {
  el: HTMLIFrameElement;
  url: string;
  track: string;
  ready: boolean;
  lastT: number;
}

type CompWindow = Window & {
  __player?: { renderSeek?: (t: number) => void; seek?: (t: number) => void };
  __timelines?: Record<string, { seek: (t: number, suppress?: boolean) => void }>;
};

/** The folder token the server uses in /comp/<token>/ URLs (base64url of the absolute path). */
export function tokenOf(abs: string): string {
  const bytes = new TextEncoder().encode(abs);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Seek a HyperFrames page: its runtime player if it has one, else its root GSAP timeline. */
export function seekComp(el: HTMLIFrameElement, local: number) {
  const w = el.contentWindow as CompWindow | null;
  if (!w) return;
  try {
    if (w.__player?.renderSeek) return w.__player.renderSeek(local);
    if (w.__player?.seek) return w.__player.seek(local);
    const tls = w.__timelines;
    if (tls) (tls.main ?? Object.values(tls)[0])?.seek(local, false);
  } catch {
    // a comp with a script error: leave it where it is
  }
}

/** Gain envelope for a clip: fade in from its start, fade out to its end, from wherever we are now. */
function envelope(p: AudioParam, level: number, a: number, b: number, fi: number, fo: number, now: number) {
  const val = (x: number) => {
    let v = level;
    if (fi > 0 && x < a + fi) v *= Math.max(0, Math.min(1, (x - a) / fi));
    if (fo > 0 && Number.isFinite(b) && x > b - fo) v *= Math.max(0, Math.min(1, (b - x) / fo));
    return v;
  };
  const at = Math.max(a, now);
  p.cancelScheduledValues(0);
  p.setValueAtTime(val(at), at);
  if (fi > 0 && a + fi > at) p.linearRampToValueAtTime(val(a + fi), a + fi);
  if (fo > 0 && Number.isFinite(b)) {
    if (b - fo > at) p.setValueAtTime(val(b - fo), b - fo);
    if (b > at) p.linearRampToValueAtTime(0, b);
  }
}

interface Voice {
  stop(): void;
  /** Long-audio element to keep in sync. */
  el?: HTMLAudioElement;
  expected?: (t: number) => number;
}

export class Player {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private playing = false;
  private anchorCtx = 0;
  private anchorT = 0;
  private voices: Voice[] = [];
  /** Bumped on every stop, so clips still decoding from an older start don't start late. */
  private gen = 0;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private slots = new Map<string, VideoSlot>();
  private images = new Map<string, HTMLImageElement>();
  private index: TimelineIndex | null = null;
  private captions = new Map<string, CaptionGroup[]>();
  private listeners = new Set<() => void>();
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private dirty = true;
  /** Measured each frame while playing: worst |video time − expected| in seconds. */
  lastDrift = 0;

  /** Layers above the top-most comp track (captions, titles over an animation). */
  private topCanvas: HTMLCanvasElement | null = null;
  /** Holds one iframe per HyperFrames comp in view. */
  private compLayer: HTMLElement | null = null;
  private comps = new Map<string, CompSlot>();
  /** Bumped when comp files change (Claude edited a scene): iframes reload. */
  compVersion = new Map<string, number>();

  constructor(private opened: Opened, private getResolved: () => Resolved, private getWords: () => readonly { w: string; s: number; e: number }[] | null, private lufs: (src: string) => number | null) {
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.master = this.ctx.createGain();
    this.master.connect(this.limiter).connect(this.ctx.destination);
    this.rebuild();
    this.preloadAudio();
    this.loop();
  }

  get project(): Project {
    return this.opened.project;
  }

  // --- public ----------------------------------------------------------------------------------
  get isPlaying() {
    return this.playing;
  }

  get duration() {
    return this.index?.end ?? 0;
  }

  time(): number {
    return this.playing ? this.anchorT + (this.ctx.currentTime - this.anchorCtx) : this.anchorT;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  attach(canvas: HTMLCanvasElement | null, top: HTMLCanvasElement | null = null, compLayer: HTMLElement | null = null) {
    this.canvas = canvas;
    this.topCanvas = top;
    this.compLayer = compLayer;
    for (const c of this.comps.values()) c.el.remove();
    this.comps.clear();
    this.dirty = true;
  }

  private get words() {
    return this.getWords();
  }

  /** Call after the project changed (an edit, an undo). */
  rebuild() {
    this.index = new TimelineIndex(this.project, this.getResolved());
    // comps whose clip changed (other file, new version) are re-created on the next frame
    for (const [id, slot] of [...this.comps]) {
      const c = this.index.tracks.get(slot.track)?.spans.find((sp) => sp.id === id)?.clip;
      if (!c || c.type !== 'comp' || this.compUrl(c) !== slot.url) {
        slot.el.remove();
        this.comps.delete(id);
      }
    }
    this.captions.clear();
    if (this.playing) this.restartAudio();
    this.dirty = true;
  }

  async play() {
    if (this.playing || this.starting) return;
    this.starting = true;
    try {
      await this.ctx.resume();
      if (this.anchorT >= this.duration - 1 / 30) this.anchorT = 0;
      // Start the visible videos first (an element takes 100-300 ms to begin playing), then start the
      // clock from where they actually are, so picture and sound begin together.
      const t = this.anchorT;
      this.syncVideo(t);
      const active = this.activeVideoSlots(t);
      await Promise.race([
        Promise.all(active.map(({ slot, expected }) => {
          slot.el.currentTime = expected;
          return slot.el.play().catch(() => {});
        })),
        new Promise((r) => setTimeout(r, 600)),
      ]);
      this.playing = true;
      this.anchorCtx = this.ctx.currentTime + 0.03;
      // the clock starts where the picture already is (it got a head start while starting up)
      const lead = active[0];
      this.anchorT = lead ? Math.max(0, t + (lead.slot.el.currentTime - lead.expected) / lead.speed) : t;
      this.startAudio(this.anchorT, this.anchorCtx);
      this.emit();
    } finally {
      this.starting = false;
    }
  }

  private starting = false;

  private activeVideoSlots(t: number): { slot: VideoSlot; expected: number; speed: number }[] {
    const out: { slot: VideoSlot; expected: number; speed: number }[] = [];
    for (const track of this.project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      for (const span of this.index?.tracks.get(track.id)?.at(t) ?? []) {
        const slot = this.slots.get(span.id);
        const r = this.getResolved().clips.get(span.id);
        if (slot && r) out.push({ slot, expected: (r.in ?? 0) + (t - span.start) * (r.speed ?? 1), speed: r.speed ?? 1 });
      }
    }
    return out;
  }

  pause() {
    if (!this.playing) return;
    this.anchorT = this.time();
    this.playing = false;
    this.stopAudio();
    for (const s of this.slots.values()) s.el.pause();
    this.dirty = true;
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(t, this.duration));
    if (this.playing) {
      this.stopAudio();
      this.anchorT = clamped;
      this.anchorCtx = this.ctx.currentTime + 0.06;
      this.startAudio(this.anchorT, this.anchorCtx);
    } else this.anchorT = clamped;
    this.dirty = true;
    this.emit();
  }

  /**
   * Draw the frame at `t` once every video involved has seeked, then return it as a PNG (works even when the
   * page isn't visible and animation frames are paused).
   */
  async snapshot(t: number, box: [number, number, number, number] | null = null, layer: 'all' | 'base' | 'top' = 'all'): Promise<Blob> {
    this.pause();
    this.anchorT = Math.max(0, Math.min(t, this.duration));
    this.syncVideo(this.anchorT);
    const deadline = Date.now() + 8000;
    const activeIds = () => {
      const ids = new Set<string>();
      for (const ti of this.index?.tracks.values() ?? []) for (const s of ti.at(this.anchorT)) ids.add(s.id);
      return ids;
    };
    const settled = () => {
      const ids = activeIds();
      return [...this.slots.values()].every((s) => !ids.has(s.clipId) || (s.ready && !s.el.seeking));
    };
    while (!settled() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      this.syncVideo(this.anchorT);
    }
    this.draw(this.anchorT); // creates image elements for stills in view
    for (const i of this.images.values()) if (!i.complete) await new Promise((r) => i.addEventListener('load', r, { once: true }));
    this.draw(this.anchorT);
    const base = this.canvas;
    if (!base) throw new Error('no viewer canvas');
    // base + layers painted over the comps (comps themselves are iframes; the server adds them for frames)
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const ctx = out.getContext('2d')!;
    if (layer !== 'top') ctx.drawImage(base, 0, 0);
    if (layer !== 'base' && this.topCanvas) ctx.drawImage(this.topCanvas, 0, 0);
    if (box) {
      ctx.strokeStyle = '#FFD400';
      ctx.lineWidth = Math.max(4, out.width / 270);
      ctx.setLineDash([18, 10]);
      ctx.strokeRect(box[0], box[1], box[2], box[3]);
    }
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  }

  /** What a frame needs from the server to be complete: the comps on screen and their local times. */
  compsAt(t: number): { clip: string; comp: string; local: number; vars: Record<string, unknown> }[] {
    const out: { clip: string; comp: string; local: number; vars: Record<string, unknown> }[] = [];
    const idx = this.index;
    if (!idx) return out;
    for (const track of this.project.tracks) {
      if (track.kind !== 'graphics' || track.hidden) continue;
      for (const sp of idx.tracks.get(track.id)?.at(t) ?? [])
        if (sp.clip.type === 'comp') out.push({ clip: sp.id, comp: sp.clip.comp, local: Math.round((t - sp.start) * 1e4) / 1e4, vars: this.getResolved().clips.get(sp.id)?.vars ?? {} });
    }
    return out;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    for (const s of this.slots.values()) this.releaseSlot(s);
    void this.ctx.close();
  }

  // --- audio -----------------------------------------------------------------------------------
  private media(src: string): MediaInfo | undefined {
    return this.opened.media[src];
  }

  private preloadAudio() {
    for (const t of this.project.tracks)
      if (t.kind === 'audio') for (const c of t.clips) if (c.type === 'media') void this.buffer(c.src);
  }

  private buffer(src: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(src);
    if (!b) {
      const m = this.media(src);
      b =
        !m?.exists || (m.duration ?? 0) > LONG_AUDIO
          ? Promise.resolve(null)
          : fetch(m.url)
              .then((r) => r.arrayBuffer())
              .then((a) => this.ctx.decodeAudioData(a))
              .catch(() => null);
      this.buffers.set(src, b);
    }
    return b;
  }

  /** dB to add so the voice plays near the toolbox's loudnorm target (I = -15 LUFS, +1.5 dB). */
  private levelFix(role: string | undefined, src: string): number {
    if (role !== 'voice') return 0;
    const l = this.lufs(src);
    return l === null ? 0 : Math.max(-12, Math.min(12, -13.5 - l));
  }

  private startAudio(t: number, when: number) {
    const idx = this.index;
    if (!idx) return;
    const end = idx.end;
    for (const track of this.project.tracks) {
      if (track.kind !== 'audio' || track.muted) continue;
      const tIdx = idx.tracks.get(track.id);
      if (!tIdx) continue;
      const trackGain = this.ctx.createGain();
      trackGain.gain.value = dbToGain(track.gain ?? 0);
      trackGain.connect(this.master);
      const spans = tIdx.query(t, Infinity);
      for (const s of spans) {
        const c = s.clip as MediaClip;
        const defaultDb = track.role === 'sfx' ? -10 : track.role === 'music' ? -22 : 0;
        const db = (c.gain ?? defaultDb) + this.levelFix(track.role, c.src);
        void this.startClip(c, s, t, when, end, trackGain, db);
      }
      this.voices.push({ stop: () => trackGain.disconnect() });
    }
  }

  private async startClip(c: MediaClip, s: Span, t: number, when: number, end: number, out: GainNode, db: number) {
    const r = this.getResolved().clips.get(c.id);
    const inPt = r?.in ?? 0;
    const speed = r?.speed ?? 1;
    const g = this.ctx.createGain();
    g.connect(out);
    const level = dbToGain(db);
    const at = when + Math.max(0, s.start - t); // context time the clip (or its remainder) starts
    const offset = inPt + Math.max(0, t - s.start) * speed;
    const stopAt = when + (s.end - t);
    const gen = this.gen;
    const buf = await this.buffer(c.src);
    if (!this.playing || gen !== this.gen) return g.disconnect();
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;
      if (c.loop) {
        src.loop = true;
        // toolbox bed: 50 ms fade in, 1.3 s fade out at the end of the video
        g.gain.setValueAtTime(0, Math.max(at, this.ctx.currentTime));
        g.gain.linearRampToValueAtTime(level, Math.max(at, this.ctx.currentTime) + (s.start >= t ? (c.fadeIn ?? 0.05) : 0.01));
        const fo = c.fadeOut ?? 1.3;
        const fadeEnd = Math.min(stopAt, when + (end - t));
        const fadeStart = fadeEnd - fo;
        if (fadeStart > at && fo > 0) {
          g.gain.setValueAtTime(level, fadeStart);
          g.gain.linearRampToValueAtTime(0, fadeEnd);
        }
      } else envelope(g.gain, level, when + (s.start - t), stopAt, c.fadeIn ?? 0, c.fadeOut ?? 0, this.ctx.currentTime);
      src.connect(g);
      const startCtx = Math.max(at, this.ctx.currentTime);
      const lateBy = startCtx - at; // async decode may finish after the start time
      src.start(startCtx, c.loop ? (offset + lateBy * speed) % buf.duration : offset + lateBy * speed);
      if (Number.isFinite(stopAt)) src.stop(Math.max(startCtx, stopAt));
      this.voices.push({ stop: () => { try { src.stop(); } catch {} g.disconnect(); } });
      return;
    }
    // long audio: stream through an element, kept in sync in the frame loop
    const m = this.media(c.src);
    if (!m?.exists) return g.disconnect();
    const el = new Audio(m.url);
    el.preload = 'auto';
    el.playbackRate = speed;
    const node = this.ctx.createMediaElementSource(el);
    node.connect(g);
    envelope(g.gain, level, when + (s.start - t), stopAt, c.fadeIn ?? 0, c.fadeOut ?? 0, this.ctx.currentTime);
    const expected = (now: number) => inPt + (now - s.start) * speed;
    el.currentTime = Math.max(inPt, offset);
    const startIn = Math.max(0, at - this.ctx.currentTime);
    const timer = window.setTimeout(() => void el.play().catch(() => {}), startIn * 1000);
    this.voices.push({ el, expected, stop: () => { clearTimeout(timer); el.pause(); el.src = ''; node.disconnect(); g.disconnect(); } });
  }

  private stopAudio() {
    this.gen++;
    for (const v of this.voices) v.stop();
    this.voices = [];
  }

  private restartAudio() {
    const t = this.time();
    this.stopAudio();
    this.anchorT = t;
    this.anchorCtx = this.ctx.currentTime + 0.06;
    this.startAudio(t, this.anchorCtx);
  }

  // --- video -----------------------------------------------------------------------------------
  private slot(span: Span): VideoSlot | null {
    let s = this.slots.get(span.id);
    if (s) return s;
    const m = this.media((span.clip as MediaClip).src);
    if (!m?.exists || m.kind !== 'video') return null;
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.src = m.url;
    s = { el, clipId: span.id, ready: false };
    const slot = s;
    el.addEventListener('loadeddata', () => { slot.ready = true; this.dirty = true; });
    el.addEventListener('seeked', () => { this.dirty = true; });
    el.addEventListener('error', () => {
      // a proxy still being made answers 202: try again shortly
      if (m.url.startsWith('/api/proxy')) setTimeout(() => { if (this.slots.get(span.id) === slot) { el.src = `${m.url}&r=${Date.now()}`; } }, 2000);
    });
    this.slots.set(span.id, s);
    return s;
  }

  private releaseSlot(s: VideoSlot) {
    s.el.pause();
    s.el.removeAttribute('src');
    s.el.load();
    this.slots.delete(s.clipId);
  }

  private image(src: string): HTMLImageElement | null {
    let img = this.images.get(src);
    if (!img) {
      const m = this.media(src);
      if (!m?.exists) return null;
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { this.dirty = true; };
      img.src = m.url;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Keep each visible (or about to be visible) video element at the right source time. */
  private syncVideo(t: number) {
    const idx = this.index;
    if (!idx) return;
    const wanted = new Set<string>();
    let drift = 0;
    for (const track of this.project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      for (const span of idx.tracks.get(track.id)?.query(t - 0.05, t + PREROLL) ?? []) {
        const c = span.clip;
        if (c.type !== 'media' || c.still) continue;
        const m = this.media(c.src);
        if (m?.kind !== 'video') continue;
        const s = this.slot(span);
        if (!s) continue;
        wanted.add(span.id);
        const r = this.getResolved().clips.get(span.id);
        const speed = r?.speed ?? 1;
        const inPt = r?.in ?? 0;
        const active = t >= span.start && t < span.end;
        const raw = inPt + (t - span.start) * speed; // where the source should be (before `in` while pre-rolling)
        const expected = Math.max(inPt, raw);
        const el = s.el;
        // pre-roll: run the next clip from just before its cut, so it's already playing when it shows
        const prerolling = this.playing && span.start > t && span.start - t < PREROLL_PLAY && raw >= 0;
        if ((active || prerolling) && this.playing) {
          const target = active ? expected : raw;
          if (el.paused) {
            el.playbackRate = speed;
            el.currentTime = target;
            void el.play().catch(() => {});
          } else {
            const err = el.currentTime - target; // + = video ahead
            if (active) drift = Math.max(drift, Math.abs(err));
            if (Math.abs(err) > HARD_DRIFT && !el.seeking) el.currentTime = target;
            else {
              // nudge the speed to close small gaps without the stall a seek causes
              const nudge = Math.abs(err) < DRIFT ? 0 : Math.max(-0.1, Math.min(0.1, -err * 0.8));
              el.playbackRate = speed * (1 + nudge);
            }
          }
        } else {
          if (!el.paused) el.pause();
          const target = active ? expected : inPt;
          if (!el.seeking && Math.abs(el.currentTime - target) > 1 / 60) el.currentTime = target;
        }
      }
    }
    this.lastDrift = drift;
    for (const s of [...this.slots.values()]) if (!wanted.has(s.clipId)) this.releaseSlot(s);
  }

  // --- drawing ---------------------------------------------------------------------------------
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    let t = this.time();
    if (this.playing && t >= this.duration) {
      this.pause();
      this.anchorT = t = this.duration;
    }
    this.syncVideo(t);
    for (const v of this.voices) {
      if (v.el && v.expected && !v.el.paused) {
        const d = Math.abs(v.el.currentTime - v.expected(t));
        if (d > 0.08) v.el.currentTime = v.expected(t);
      }
    }
    if (this.playing || this.dirty) {
      this.draw(t);
      this.dirty = false;
      this.emit();
    }
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private draw(t: number) {
    const cv = this.canvas;
    const idx = this.index;
    if (!cv || !idx) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const p = this.project;
    if (cv.width !== p.width || cv.height !== p.height) {
      cv.width = p.width;
      cv.height = p.height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    // the toolbox lays Shorts out on a 1080-wide frame; scale for other formats
    const k = p.width / 1080;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // tracks above the last one holding a comp paint on the top canvas, over the comp iframes
    let lastComp = -1;
    p.tracks.forEach((tr, i) => {
      if (!tr.hidden && tr.kind === 'graphics' && tr.clips.some((c) => c.type === 'comp')) lastComp = i;
    });
    const top = this.topCanvas;
    let tctx: CanvasRenderingContext2D | null = null;
    if (top) {
      if (top.width !== p.width || top.height !== p.height) {
        top.width = p.width;
        top.height = p.height;
      }
      tctx = top.getContext('2d');
      if (tctx) {
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, top.width, top.height);
        tctx.setTransform(k, 0, 0, k, 0, 0);
      }
    }
    const wanted = new Set<string>();
    for (const [ti, track] of p.tracks.entries()) {
      if (track.hidden) continue;
      if (track.kind === 'graphics' && this.compLayer)
        for (const sp of idx.tracks.get(track.id)?.query(t - 0.05, t + PREROLL) ?? [])
          if (sp.clip.type === 'comp') {
            wanted.add(sp.id);
            this.syncComp(sp, track.id, ti, t);
          }
      this.drawTrack(lastComp >= 0 && ti > lastComp && tctx ? tctx : ctx, track, t);
    }
    for (const [id, slot] of [...this.comps])
      if (!wanted.has(id)) {
        slot.el.remove();
        this.comps.delete(id);
      }
  }

  private drawTrack(ctx: CanvasRenderingContext2D, track: Project['tracks'][number], t: number) {
    const idx = this.index!;
    if (track.kind === 'captions') {
      if (track.enabled !== false) this.drawCaptions(ctx, track.id, (track.style ?? {}) as { y?: number; max_words?: number }, t);
      return;
    }
    if (track.kind === 'audio') return;
    let spans = idx.tracks.get(track.id)?.at(t) ?? [];
    if (track.kind === 'graphics') spans = [...spans].sort((a, b) => layerOf(a.clip) - layerOf(b.clip) || a.order - b.order);
    for (const s of spans) this.drawClip(ctx, s, t);
  }

  // --- HyperFrames comps -------------------------------------------------------------------------
  compUrl(c: Clip): string {
    if (c.type !== 'comp') return '';
    const v = Math.max(this.compVersion.get(c.id) ?? 0, this.compVersion.get('*') ?? 0);
    const vars = JSON.stringify(this.getResolved().clips.get(c.id)?.vars ?? {});
    const folder = /^([a-z]:[\\/]|[\\/])/i.test(c.comp) ? c.comp : `${this.opened.dir.replace(/[\\/]$/, '')}/${c.comp}`;
    return `/comp/${tokenOf(folder)}/index.html?${new URLSearchParams({ clip: c.id, v: String(v), vars })}`;
  }

  /** One iframe per comp clip in view (or about to be), seeked to clip-local time every frame. */
  private syncComp(sp: Span, trackId: string, z: number, t: number) {
    const c = sp.clip as CompClip;
    let slot = this.comps.get(sp.id);
    const url = this.compUrl(c);
    if (!slot || slot.url !== url) {
      slot?.el.remove();
      const el = document.createElement('iframe');
      el.className = 'comp-frame';
      el.src = url;
      el.dataset.clip = sp.id;
      el.setAttribute('scrolling', 'no');
      el.style.width = `${this.project.width}px`;
      el.style.height = `${this.project.height}px`;
      el.style.zIndex = String(z);
      const s2: CompSlot = { el, url, track: trackId, ready: false, lastT: -1 };
      el.addEventListener('load', () => {
        s2.ready = true;
        s2.lastT = -1;
        this.dirty = true;
      });
      this.compLayer!.appendChild(el);
      this.comps.set(sp.id, s2);
      slot = s2;
    }
    const active = t >= sp.start && t < sp.end;
    slot.el.style.visibility = active ? 'visible' : 'hidden';
    if (!active || !slot.ready) return;
    const local = Math.max(0, t - sp.start);
    if (Math.abs(local - slot.lastT) < 1e-4) return;
    slot.lastT = local;
    seekComp(slot.el, local);
  }

  /** Comps on screen now, top first: their iframes and clip-local times (for picking and for frames). */
  activeComps(t = this.time()): { clip: string; el: HTMLIFrameElement; local: number }[] {
    const out: { clip: string; el: HTMLIFrameElement; local: number }[] = [];
    for (const [id, slot] of this.comps) {
      const sp = this.index?.tracks.get(slot.track)?.spans.find((x) => x.id === id);
      if (sp && t >= sp.start && t < sp.end) out.push({ clip: id, el: slot.el, local: t - sp.start });
    }
    return out.sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex));
  }

  /** The top canvas (layers over comps), for snapshots. */
  get overlayCanvas() {
    return this.topCanvas;
  }

  private drawClip(ctx: CanvasRenderingContext2D, s: Span, t: number) {
    const c = s.clip;
    const local = t - s.start;
    if (c.type === 'generator') {
      const prm = c.params as { c0?: string; c1?: string; image?: string; color?: string };
      if (c.generator === 'radial-gradient') {
        // ffmpeg gradients=type=radial from (540,700) to (540,1920)
        const g = ctx.createRadialGradient(540, 700, 0, 540, 700, 1220);
        g.addColorStop(0, color(prm.c0, '#16203a'));
        g.addColorStop(1, color(prm.c1, '#06080d'));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 1080, 1920);
      } else if (c.generator === 'image' && prm.image) {
        const img = this.image(prm.image);
        if (img) ctx.drawImage(img, 0, 0, 1080, 1920);
      } else {
        ctx.fillStyle = color(prm.color, '#000');
        ctx.fillRect(0, 0, 1080, 1920);
      }
      return;
    }
    if (c.type === 'title') return drawTitle(ctx, c as TitleClip, local, s.end - s.start);
    if (c.type === 'comp') {
      if (this.compLayer) return; // drawn by its iframe
      ctx.fillStyle = 'rgba(255,179,71,0.18)';
      ctx.fillRect(0, 0, 1080, 1920);
      ctx.fillStyle = '#ffb347';
      ctx.font = '600 40px "Segoe UI", sans-serif';
      ctx.fillText(`HyperFrames: ${c.comp}`, 60, 120);
      return;
    }
    if (c.type !== 'media') return;
    const m = this.media(c.src);
    const r = this.getResolved().clips.get(c.id);
    let source: CanvasImageSource | null = null;
    let natW = m?.width ?? 0;
    let natH = m?.height ?? 0;
    let scale = 1;
    if (c.still || m?.kind === 'image') {
      const img = this.image(c.src);
      if (img) {
        source = img;
        natW = img.naturalWidth;
        natH = img.naturalHeight;
      }
    } else {
      const slot = this.slots.get(c.id);
      if (slot?.ready && slot.el.videoWidth) {
        source = slot.el;
        // proxies are smaller than the original: regions are in original pixels
        scale = natW ? slot.el.videoWidth / natW : 1;
      }
    }
    const region = this.region(c, natW, natH);
    const geo = cardGeometry(region, c.cardW ?? 1080, c.cy ?? 900, r?.keys, local);
    if (!source) {
      ctx.fillStyle = '#111';
      ctx.fillRect(geo.dx, geo.dy, geo.dw, geo.dh);
      return;
    }
    ctx.save();
    const dur = s.end - s.start;
    const fi = c.fadeIn ?? 0;
    const fo = c.fadeOut ?? 0;
    let alpha = 1;
    if (fi > 0 && local < fi) alpha = Math.min(alpha, local / fi);
    if (fo > 0 && dur - local < fo) alpha = Math.min(alpha, (dur - local) / fo);
    ctx.globalAlpha = Math.max(0, alpha);
    if (c.dim) ctx.filter = 'blur(6px) brightness(0.72)';
    ctx.drawImage(source, geo.sx * scale, geo.sy * scale, geo.sw * scale, geo.sh * scale, geo.dx, geo.dy, geo.dw, geo.dh);
    ctx.filter = 'none';
    // privacy blurs, in source pixels like delogo
    for (const b of this.blurs(c)) {
      const [bx, by, bw, bh] = b;
      const fx = (bx - geo.sx) / geo.sw;
      const fy = (by - geo.sy) / geo.sh;
      const dx = geo.dx + fx * geo.dw;
      const dy = geo.dy + fy * geo.dh;
      const dw = (bw / geo.sw) * geo.dw;
      const dh = (bh / geo.sh) * geo.dh;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      ctx.clip();
      ctx.filter = 'blur(10px)';
      ctx.drawImage(source, bx * scale, by * scale, bw * scale, bh * scale, dx, dy, dw, dh);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.strokeRect(geo.dx + 1.5, geo.dy + 1.5, geo.dw - 3, geo.dh - 3);
    ctx.restore();
  }

  private region(c: MediaClip, w: number, h: number): [number, number, number, number] {
    const r = c.region;
    if (Array.isArray(r)) return r;
    if (typeof r === 'string' && this.project.regions[r]) return this.project.regions[r]!;
    return [0, 0, w || 1080, h || 1920];
  }

  private blurs(c: MediaClip): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (const b of c.blur ?? []) {
      const v = typeof b === 'string' ? this.project.blurs[b] : b;
      if (!v) continue;
      if (Array.isArray(v[0])) out.push(...(v as [number, number, number, number][]));
      else out.push(v as [number, number, number, number]);
    }
    return out;
  }

  private drawCaptions(ctx: CanvasRenderingContext2D, trackId: string, style: { y?: number; max_words?: number }, t: number) {
    if (!this.words?.length) return;
    let groups = this.captions.get(trackId);
    if (!groups) {
      groups = captionGroups(this.words, this.duration, style.max_words ?? 3);
      this.captions.set(trackId, groups);
    }
    const g = findGroup(groups, t);
    if (g) drawCaption(ctx, g, t, style.y ?? 1480);
  }
}

function layerOf(c: Clip): number {
  return c.type === 'title' ? titleLayer(c) : 1;
}
