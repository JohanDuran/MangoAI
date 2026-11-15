// short.json (media-toolbox Shorts spec) <-> cut.json. Import keeps every field, including ones MangoAI
// doesn't model (they go to `extra`), and records where each clip came from (`origin`), so
// exportShortJson(importShortJson(x)) gives back x. Time expressions are kept as written, never resolved.
import { FORMAT, FORMAT_VERSION, type Clip, type MediaClip, type Project, type TitleClip, type Track } from '../schema.js';
import { resolveProject } from '../resolve.js';
import type { WordIndex } from '../time.js';

type Json = Record<string, unknown>;

const DEFAULT_WORDS = 'transcripts/narration.words.tsv';
const META = '$shortjson';

const LAYER_FIELDS: Record<string, string> = {
  src: 'src', ss: 'in', speed: 'speed', speed_to: 'speedTo', still: 'still', region: 'region', blur: 'blur',
  card_w: 'cardW', cy: 'cy', dim: 'dim', keys: 'keys',
};
const GRAPHIC_FIELDS = ['start', 'end', 'style', 'pos', 'text', 'runs', 'fs', 'bold', 'color', 'box', 'strike', 'pop', 'fade', 'shape', 'layer'];
const TOP_FIELDS = ['version', 'title', 'words', 'fps', 'sources', 'regions', 'blurs', 'anchors', 'shots', 'graphics', 'captions', 'audio', 'backdrop'];

export class ShortJsonError extends Error {}

export interface ImportOptions {
  /** With words and media lengths, SFX that overlap are spread over several audio tracks. */
  words?: WordIndex;
  durations?: ReadonlyMap<string, number>;
}

function split(obj: Json, known: string[]): { known: Json; extra?: Json } {
  const k: Json = {};
  const x: Json = {};
  for (const [key, v] of Object.entries(obj)) (known.includes(key) ? k : x)[key] = v;
  return Object.keys(x).length ? { known: k, extra: x } : { known: k };
}

export function importShortJson(spec: Json, opts: ImportOptions = {}): Project {
  const top = split(spec, TOP_FIELDS);
  const s = top.known as {
    title?: string; words?: string; fps?: number; sources?: Json; regions?: Json; blurs?: Json; anchors?: Json;
    shots?: Json[]; graphics?: Json[]; captions?: Json; audio?: Json; backdrop?: Json;
  };
  if (spec.version !== undefined && spec.version !== 1) throw new ShortJsonError(`short.json version ${String(spec.version)} is not supported`);

  const tracks: Track[] = [];
  const project: Project = {
    format: FORMAT,
    version: FORMAT_VERSION,
    revision: 0,
    ...(s.title !== undefined && { title: s.title }),
    width: 1080,
    height: 1920,
    fps: s.fps ?? 30,
    transcripts: { voice: s.words ?? DEFAULT_WORDS },
    sources: (s.sources ?? {}) as Record<string, string>,
    regions: (s.regions ?? {}) as Project['regions'],
    blurs: (s.blurs ?? {}) as Project['blurs'],
    anchors: Object.entries(s.anchors ?? {}).map(([name, at]) => ({ name, at: at as string | number })),
    sections: [],
    tracks,
    extra: { ...(top.extra ?? {}), [META]: { keys: Object.keys(spec) } },
  };

  // Backdrop: a generator clip under everything.
  if (s.backdrop) {
    const gen = 'image' in s.backdrop ? 'image' : 'radial-gradient';
    tracks.push({
      id: 'V1', kind: 'video', name: 'Backdrop',
      clips: [{ id: 'backdrop', type: 'generator', generator: gen, params: s.backdrop, start: 0, end: 'timeline_end', origin: 'backdrop' }],
    });
  }

  // Shots -> sections; each layer j -> a media clip on video track V(j+2).
  const layerTracks: Track[] = [];
  (s.shots ?? []).forEach((shot, i) => {
    const sh = split(shot, ['name', 'end', 'note', 'layers']);
    const { name, end, note, layers } = sh.known as { name: string; end: string | number; note?: string; layers?: Json[] };
    if (typeof name !== 'string') throw new ShortJsonError(`shot ${i} has no name`);
    project.sections.push({ id: name, end, ...(note !== undefined && { note }), ...(sh.extra && { extra: sh.extra }) });
    (layers ?? []).forEach((layer, j) => {
      const track = (layerTracks[j] ??= { id: `V${j + 2}`, kind: 'video', name: j === 0 ? 'Shots' : `Shots layer ${j + 1}`, clips: [] });
      const lx = split(layer, Object.keys(LAYER_FIELDS));
      const clip: Json = { id: `${name}.L${j}`, type: 'media', start: `${name}.start`, end: `${name}.end`, origin: `shot:${i}/layer:${j}` };
      for (const [from, to] of Object.entries(LAYER_FIELDS)) if (from in lx.known) clip[to] = lx.known[from];
      if (lx.extra) clip.extra = lx.extra;
      clip.label = name;
      track.clips.push(clip as MediaClip);
    });
  });
  tracks.push(...layerTracks);

  // Graphics -> title clips; one graphics track per ASS layer value.
  const gTracks = new Map<string, Track>();
  (s.graphics ?? []).forEach((g, i) => {
    const gx = split(g, GRAPHIC_FIELDS);
    const k = gx.known as Json;
    const key = k.layer === undefined ? 'G1' : `G-L${String(k.layer)}`;
    let t = gTracks.get(key);
    if (!t) gTracks.set(key, (t = { id: key, kind: 'graphics', name: key === 'G1' ? 'Titles' : `Titles layer ${String(k.layer)}`, clips: [] }));
    const clip: Json = { id: `g${i}`, type: 'title', ...k, origin: `graphic:${i}` };
    if (typeof k.text === 'string') clip.label = k.text.slice(0, 40);
    if (gx.extra) clip.extra = gx.extra;
    t.clips.push(clip as TitleClip);
  });
  tracks.push(...[...gTracks.values()].sort((a, b) => layerNo(a.id) - layerNo(b.id)));

  // Captions.
  if (s.captions) {
    const { enabled, ...style } = s.captions as Json & { enabled?: boolean };
    tracks.push({ id: 'C1', kind: 'captions', name: 'Captions', transcript: 'voice', style, ...(enabled !== undefined && { enabled }), clips: [] });
  }

  // Audio: voice, SFX (one clip per hit), music.
  if (s.audio) {
    const ax = split(s.audio, ['narration', 'music', 'music_db', 'sfx']);
    const a = ax.known as { narration?: string; music?: string; music_db?: number; sfx?: Json[] };
    if (a.narration !== undefined)
      tracks.push({ id: 'A1', kind: 'audio', role: 'voice', name: 'Voice', clips: [{ id: 'voice', type: 'media', src: a.narration, start: 0, origin: 'narration' }] });
    const sfxClips: MediaClip[] = [];
    (a.sfx ?? []).forEach((fx, i) => {
      const fxx = split(fx, ['file', 'peak', 'at', 'gain']);
      const f = fxx.known as { file: string; peak?: number; at?: (string | number)[]; gain?: number };
      const ats = f.at ?? [];
      if (ats.length === 0) throw new ShortJsonError(`audio.sfx[${i}] has no "at" times`);
      ats.forEach((at, j) => {
        const clip: MediaClip = {
          id: `sfx${i}.${j}`, type: 'media', src: f.file, start: at, origin: `sfx:${i}/at:${j}`,
          ...(f.peak !== undefined && { pivot: f.peak }),
          ...(f.gain !== undefined && { gain: f.gain }),
          ...(fxx.extra && { extra: fxx.extra }),
          label: sfxLabel(f.file),
        };
        sfxClips.push(clip);
      });
    });
    tracks.push(...packSfx(project, sfxClips, opts));
    if (a.music !== undefined || a.music_db !== undefined) {
      const clip: MediaClip = {
        id: 'music', type: 'media', src: a.music ?? '', start: 0, end: 'timeline_end', loop: true, origin: 'music',
        ...(a.music_db !== undefined && { gain: a.music_db }),
      };
      tracks.push({ id: 'A9', kind: 'audio', role: 'music', name: 'Music', clips: a.music !== undefined ? [clip] : [], ...(a.music === undefined && { extra: { music_db: a.music_db } }) });
    }
    if (ax.extra) project.extra!.audio = ax.extra;
  }
  return project;
}

function layerNo(id: string): number {
  const m = /^G-L(-?\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function sfxLabel(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/_s\d+_\d+\.\w+$/, '').replace(/\.\w+$/, '').split('-').slice(0, 3).join(' ');
}

/** Spread SFX clips over as few tracks as needed so none overlap (needs times and lengths), else one track. */
function packSfx(project: Project, clips: MediaClip[], opts: ImportOptions): Track[] {
  if (clips.length === 0) return [];
  const one = (n: number, cs: MediaClip[]): Track => ({ id: `A${n + 1}`, kind: 'audio', role: 'sfx', name: n === 1 ? 'SFX' : `SFX ${n}`, clips: cs });
  if (!opts.words || !opts.durations) return [one(1, clips)];
  const probe: Project = { ...project, tracks: [{ id: 'tmp', kind: 'audio', clips }] };
  const r = resolveProject(probe, { words: opts.words, durations: opts.durations });
  const lanes: { end: number; clips: MediaClip[] }[] = [];
  const timed = clips.map((c) => ({ c, r: r.clips.get(c.id) })).sort((x, y) => (x.r?.start ?? 0) - (y.r?.start ?? 0));
  for (const { c, r: rc } of timed) {
    const start = rc?.start ?? 0;
    const end = rc?.end ?? start;
    let lane = lanes.find((l) => l.end <= start);
    if (!lane) lanes.push((lane = { end, clips: [] }));
    lane.clips.push(c);
    lane.end = end;
  }
  return lanes.map((l, n) => one(n + 1, l.clips));
}

// --- export ------------------------------------------------------------------------------------

/** Write a project back as short.json. Throws if the timeline uses things short.json can't express. */
export function exportShortJson(p: Project): Json {
  const meta = (p.extra?.[META] ?? {}) as { keys?: string[] };
  const { [META]: _meta, audio: audioExtra, ...topExtra } = (p.extra ?? {}) as Json;
  const out: Json = {};
  out.version = 1;
  if (p.title !== undefined) out.title = p.title;
  const words = p.transcripts.voice ?? Object.values(p.transcripts)[0];
  if (words !== undefined) out.words = words;
  if (p.fps !== 30 || meta.keys?.includes('fps')) out.fps = p.fps;
  out.sources = p.sources;
  out.regions = p.regions;
  out.blurs = p.blurs;
  out.anchors = Object.fromEntries(p.anchors.map((a) => [a.name, a.at]));

  const byOrigin = new Map<string, Clip>();
  const all: { clip: Clip; track: Track }[] = [];
  for (const t of p.tracks) for (const c of t.clips) {
    all.push({ clip: c, track: t });
    if (c.origin) byOrigin.set(c.origin, c);
  }

  // Shots from sections; layers are the video media clips that span each section.
  out.shots = p.sections.map((sec, i) => {
    const shot: Json = { name: sec.id, end: sec.end };
    if (sec.note !== undefined) shot.note = sec.note;
    const layers = all
      .filter(({ clip, track }) => track.kind === 'video' && clip.type === 'media' && clip.start === `${sec.id}.start`)
      .map(({ clip, track }) => ({ clip: clip as MediaClip, order: layerOrder(clip.origin, i, p.tracks.indexOf(track)) }))
      .sort((a, b) => a.order - b.order)
      .map(({ clip }) => {
        if (clip.end !== `${sec.id}.end`) throw new ShortJsonError(`clip ${clip.id} doesn't span section ${sec.id}; short.json can't express that`);
        const layer: Json = {};
        for (const [from, to] of Object.entries(LAYER_FIELDS)) {
          const v = (clip as Json)[to];
          if (v !== undefined) layer[from] = v;
        }
        return { ...layer, ...(clip.extra ?? {}) };
      });
    shot.layers = layers;
    return { ...shot, ...(sec.extra ?? {}) };
  });

  // Graphics in their original order, new ones after.
  const titles = all.filter(({ clip }) => clip.type === 'title').map(({ clip }) => clip as TitleClip);
  titles.sort((a, b) => originNo(a.origin, 'graphic') - originNo(b.origin, 'graphic'));
  out.graphics = titles.map((c) => {
    const g: Json = {};
    for (const f of GRAPHIC_FIELDS) {
      const v = (c as Json)[f];
      if (v !== undefined) g[f] = v;
    }
    return { ...g, ...(c.extra ?? {}) };
  });

  const cap = p.tracks.find((t) => t.kind === 'captions');
  if (cap) out.captions = { ...(cap.style ?? {}), ...(cap.enabled !== undefined && { enabled: cap.enabled }) };

  const audio: Json = {};
  const voice = byOrigin.get('narration') ?? p.tracks.find((t) => t.role === 'voice')?.clips[0];
  if (voice?.type === 'media') audio.narration = voice.src;
  const musicTrack = p.tracks.find((t) => t.role === 'music');
  const music = musicTrack?.clips[0];
  if (music?.type === 'media') {
    audio.music = music.src;
    if (music.gain !== undefined) audio.music_db = music.gain;
  } else if (musicTrack?.extra?.music_db !== undefined) audio.music_db = musicTrack.extra.music_db;
  const sfxClips = p.tracks.filter((t) => t.role === 'sfx').flatMap((t) => t.clips) as MediaClip[];
  const groups = new Map<string, { order: number; clips: { j: number; c: MediaClip }[] }>();
  let fresh = 1e6;
  for (const c of sfxClips) {
    const m = /^sfx:(\d+)\/at:(\d+)$/.exec(c.origin ?? '');
    const key = m ? `o${m[1]}` : `n${c.src}|${c.pivot}|${c.gain}`;
    const g = groups.get(key) ?? { order: m ? Number(m[1]) : fresh++, clips: [] };
    g.clips.push({ j: m ? Number(m[2]) : 1e6 + g.clips.length, c });
    groups.set(key, g);
  }
  if (sfxClips.length || (meta.keys?.includes('audio') ?? false)) {
    audio.sfx = [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map((g) => {
        const cs = g.clips.sort((a, b) => a.j - b.j).map((x) => x.c);
        const first = cs[0]!;
        const fx: Json = { file: first.src };
        if (first.pivot !== undefined) fx.peak = first.pivot;
        fx.at = cs.map((c) => c.start);
        if (first.gain !== undefined) fx.gain = first.gain;
        return { ...fx, ...(first.extra ?? {}) };
      });
  }
  if (Object.keys(audio).length || audioExtra) out.audio = { ...audio, ...((audioExtra as Json) ?? {}) };

  const bd = byOrigin.get('backdrop');
  if (bd?.type === 'generator') out.backdrop = bd.params;

  Object.assign(out, topExtra);

  // Same key order as the original file, and only the optional maps it had.
  if (meta.keys) {
    const ordered: Json = {};
    for (const k of meta.keys) if (k in out) ordered[k] = out[k];
    for (const [k, v] of Object.entries(out)) {
      if (k in ordered) continue;
      if (isEmpty(v) && ['regions', 'blurs', 'sources', 'anchors', 'graphics'].includes(k)) continue;
      ordered[k] = v;
    }
    return ordered;
  }
  return out;
}

function isEmpty(v: unknown): boolean {
  return (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
}

function layerOrder(origin: string | undefined, _shot: number, trackIndex: number): number {
  const m = /^shot:\d+\/layer:(\d+)$/.exec(origin ?? '');
  return m ? Number(m[1]) : 1000 + trackIndex;
}

function originNo(origin: string | undefined, kind: string): number {
  const m = new RegExp(`^${kind}:(\\d+)$`).exec(origin ?? '');
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
