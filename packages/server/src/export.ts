// Export: render once, re-rendering only what changed.
//   picture: the timeline is cut into segments at edit points; each segment is rendered by ffmpeg into
//            .mangoai/renders/seg-<hash>.mp4, keyed by everything visible in it. Unchanged segments are reused.
//   comps:   each HyperFrames comp clip renders to a transparent .mov, keyed by its files + vars + size.
//   sound:   one mix of every audio clip (cached by its own hash), brought to the target loudness.
//   output:  segments joined with concat (no re-encode) + the mix → renders/<name>.mp4
// The geometry and title styles follow media-toolbox's shorts_build.py, like the live preview does.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Clip, CompClip, MediaClip, Project, Resolved, TitleClip, Track } from '@mangoai/core';
import { compCached, compDir, compHash, renderComp } from './comps.js';
import { broadcast } from './events.js';
import { peaks, probe, type MediaInfo } from './media.js';
import { cacheOf, editorFor, load } from './projects.js';

const run = promisify(execFile);
const RENDERER = 3; // bump when the output of a segment render changes, to invalidate caches

// --- toolbox look -------------------------------------------------------------------------------
const COLORS: Record<string, string> = {
  white: 'FFFFFF', yellow: 'FFD400', green: '3DDC84', red: 'FF4D4D', orange: 'D97757', grey: 'A0A0A0',
  blue: '50A0F0', darkgreen: '2B9E34', ink: '1E1F24', card: '20222A', black: '000000',
};

function hex(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const k = c.trim().toLowerCase();
  if (COLORS[k]) return COLORS[k]!;
  if (/^#?[0-9a-f]{6}$/i.test(k)) return k.replace('#', '').toUpperCase();
  const ass = /^&h([0-9a-f]{2})?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})&?$/i.exec(k);
  if (ass) return `${ass[4]}${ass[3]}${ass[2]}`.toUpperCase();
  if (/^0x[0-9a-f]{6}$/i.test(k)) return k.slice(2).toUpperCase();
  return fallback;
}
/** #RRGGBB → ASS &HBBGGRR& */
const assColor = (c: string | undefined, fallback = 'FFFFFF') => {
  const h = hex(c, fallback);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
};

const POP = '\\fscx70\\fscy70\\t(0,140,\\fscx108\\fscy108)\\t(140,220,\\fscx100\\fscy100)';

function assHeader(playY: number) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: ${Math.round(playY)}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Black,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,7,3,5,40,40,0,1
Style: Head,Segoe UI Black,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,3,5,40,40,0,1
Style: Big,Segoe UI Black,168,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,9,4,5,40,40,0,1
Style: Tag,Segoe UI Black,54,&H00FFFFFF,&H00FFFFFF,&H004D4DFF,&H00000000,0,0,0,0,100,100,2,0,3,16,0,5,40,40,0,1
Style: Card,Segoe UI,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Shape,Segoe UI,20,&H00241F1E,&H00241F1E,&H005777D9,&H00000000,0,0,0,0,100,100,0,0,1,3,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function ts(t: number): string {
  let cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  cs -= h * 360000;
  const m = Math.floor(cs / 6000);
  cs -= m * 6000;
  const s = Math.floor(cs / 100);
  cs -= s * 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function roundedRect(w: number, h: number, r: number) {
  return `m ${r} 0 l ${w - r} 0 b ${w} 0 ${w} 0 ${w} ${r} l ${w} ${h - r} b ${w} ${h} ${w} ${h} ${w - r} ${h} l ${r} ${h} b 0 ${h} 0 ${h} 0 ${h - r} l 0 ${r} b 0 0 0 0 ${r} 0`;
}

/** One title clip → one ASS Dialogue line (same tags as the toolbox's graphic_event). */
function titleEvent(g: TitleClip, t0: number, t1: number): string {
  const tags: string[] = [];
  if (g.pos) tags.push(`\\pos(${Math.round(g.pos[0])},${Math.round(g.pos[1])})`);
  if (g.fs !== undefined) tags.push(`\\fs${Math.round(g.fs)}`);
  if (g.bold !== undefined) tags.push(`\\b${g.bold ? 1 : 0}`);
  if (g.color) tags.push(`\\c${assColor(g.color)}`);
  if (g.box) tags.push(`\\3c${assColor(g.box, 'FF4D4D')}`);
  if (g.strike) tags.push('\\s1');
  if (g.pop ?? true) tags.push(POP);
  if (g.fade) tags.push(`\\fad(${Math.round(g.fade[0])},${Math.round(g.fade[1])})`);
  let style = g.style ?? 'Head';
  let body: string;
  if (g.shape) {
    const sh = g.shape as { w: number; h: number; r?: number; fill?: string; border?: string; bord?: number };
    tags.push(`\\1c${assColor(sh.fill, '20222A')}`, `\\3c${assColor(sh.border, 'FFFFFF')}`, `\\bord${Math.round(sh.bord ?? 4)}`, '\\p1');
    body = roundedRect(Math.round(sh.w), Math.round(sh.h), Math.round(sh.r ?? 36)) + '{\\p0}';
    style = 'Shape';
  } else if (g.runs) body = g.runs.map(([t, c]) => `{\\c${assColor(c)}}${t}`).join('');
  else body = String(g.text ?? '');
  const layer = g.layer ?? (style === 'Shape' ? 2 : style === 'Tag' ? 3 : 1);
  return `Dialogue: ${layer},${ts(t0)},${ts(t1)},${style},,0,0,0,,{${tags.join('')}}${body}`;
}

interface W {
  w: string;
  s: number;
  e: number;
}

/** Word-by-word captions, as the toolbox's caption_events: groups of max_words, current word yellow. */
function captionEvents(words: readonly W[], end: number, y: number, maxWords: number, a: number, b: number): string[] {
  const groups: W[][] = [];
  let cur: W[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length === maxWords || /[.,?!]$/.test(w.w)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  const out: string[] = [];
  const yellow = assColor('yellow');
  const white = assColor('white');
  groups.forEach((g, gi) => {
    const gEnd = gi + 1 < groups.length ? groups[gi + 1]![0]!.s : end;
    if (gEnd <= a || g[0]!.s >= b) return;
    g.forEach((w, wi) => {
      const t0 = wi === 0 ? g[0]!.s : w.s;
      const t1 = wi + 1 < g.length ? g[wi + 1]!.s : gEnd;
      if (t1 <= a || t0 >= b) return;
      const parts = g.map((x, k) => {
        const txt = x.w.toUpperCase().replace(/[.,]+$/, '');
        return k === wi ? `{\\c${yellow}}${txt}{\\c${white}}` : txt;
      });
      const pop = wi === 0 ? '\\fscx85\\fscy85\\t(0,90,\\fscx100\\fscy100)' : '';
      out.push(`Dialogue: 5,${ts(t0 - a)},${ts(t1 - a)},Cap,,0,0,0,,{\\pos(540,${y})${pop}}${parts.join(' ')}`);
    });
  });
  return out;
}

function ease(a: number, b: number, ta: number, tb: number) {
  const s = `clip((it-${ta.toFixed(3)})/${Math.max(tb - ta, 1e-3).toFixed(3)},0,1)`;
  return `(${a}+(${b}-(${a}))*(${s})*(${s})*(3-2*(${s})))`;
}

function keyed(keys: number[][], idx: number) {
  let expr = String(keys[keys.length - 1]![idx]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const ka = keys[i]!;
    const kb = keys[i + 1]!;
    expr = `if(lt(it,${kb[0]!.toFixed(3)}),${ease(ka[idx]!, kb[idx]!, ka[0]!, kb[0]!)},${expr})`;
  }
  return expr;
}

// --- ffmpeg helpers ------------------------------------------------------------------------------
async function ff(args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().slice(-2000)}`))));
  });
}

const exists = (f: string) => fs.stat(f).then((s) => s.size > 0, () => false);

async function fileId(file: string): Promise<string> {
  try {
    const st = await fs.stat(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

const sha = (x: unknown) => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);

// --- planning --------------------------------------------------------------------------------------
interface Ctx {
  dir: string;
  p: Project;
  r: Resolved;
  fps: number;
  W: number;
  H: number;
  k: number;
  end: number;
  media: Map<string, MediaInfo & { abs: string; id: string }>;
  compRenders: Map<string, { file: string | null; cached: boolean }>;
  work: string;
}

const F = (t: number, fps: number) => Math.round(t * fps);

async function context(dir: string): Promise<Ctx> {
  const st = await load(dir, true);
  const ed = editorFor(st);
  const p = ed.project;
  const r = ed.resolve();
  const media = new Map<string, MediaInfo & { abs: string; id: string }>();
  for (const t of p.tracks)
    for (const c of t.clips) {
      const src = c.type === 'media' ? c.src : c.type === 'generator' && typeof c.params.image === 'string' ? c.params.image : null;
      if (!src || media.has(src)) continue;
      const abs = path.resolve(dir, p.sources[src] ?? src);
      media.set(src, { ...(await probe(abs, cacheOf(dir))), abs, id: await fileId(abs) });
    }
  const work = path.join(cacheOf(dir), 'renders');
  await fs.mkdir(work, { recursive: true });
  return { dir, p, r, fps: p.fps, W: p.width, H: p.height, k: p.width / 1080, end: r.end, media, compRenders: new Map(), work };
}

const visual = (t: Track) => !t.hidden && (t.kind === 'video' || t.kind === 'graphics' || t.kind === 'captions');

/** Segment boundaries: sections (a Short's shots), else edit points packed into 4–20 s pieces. */
function segmentsOf(c: Ctx): [number, number][] {
  const endF = F(c.end, c.fps);
  if (endF <= 0) return [];
  let cuts: number[];
  if (c.r.sections.length) cuts = c.r.sections.map((s) => F(s.t1, c.fps));
  else {
    const pts = new Set<number>();
    for (const t of c.p.tracks)
      if (t.kind === 'video' || (t.kind === 'graphics' && t.clips.some((x) => x.type === 'comp')))
        for (const cl of t.clips) {
          const rc = c.r.clips.get(cl.id);
          if (!rc) continue;
          pts.add(F(rc.start, c.fps));
          if (rc.end !== null) pts.add(F(rc.end, c.fps));
        }
    cuts = [...pts].sort((a, b) => a - b);
  }
  const min = 4 * c.fps;
  const max = 20 * c.fps;
  const out: [number, number][] = [];
  let start = 0;
  const all = [...cuts.filter((x) => x > 0 && x < endF), endF];
  for (const cut of all) {
    while (cut - start > max) {
      out.push([start, start + max]);
      start += max;
    }
    if (cut - start >= min || cut === endF) {
      if (cut > start) out.push([start, cut]);
      start = cut;
    }
  }
  if (start < endF) out.push([start, endF]);
  // a last tiny piece joins the one before it
  if (out.length > 1 && out[out.length - 1]![1] - out[out.length - 1]![0] < c.fps) {
    const last = out.pop()!;
    out[out.length - 1]![1] = last[1];
  }
  return out;
}

interface Item {
  track: Track;
  ti: number;
  clip: Clip;
  start: number;
  end: number;
}

function itemsIn(c: Ctx, a: number, b: number): Item[] {
  const out: Item[] = [];
  c.p.tracks.forEach((track, ti) => {
    if (!visual(track) || track.kind === 'captions') return;
    for (const clip of track.clips) {
      const rc = c.r.clips.get(clip.id);
      if (!rc) continue;
      const end = rc.end ?? c.end;
      if (end <= a || rc.start >= b) continue;
      out.push({ track, ti, clip, start: rc.start, end });
    }
  });
  return out;
}

function captionWords(c: Ctx, track: Track) {
  const name = track.transcript;
  return c.r.words.filter((w) => !name || w.transcript === name || Object.keys(c.p.transcripts).length <= 1);
}

async function segmentKey(c: Ctx, a: number, b: number): Promise<string> {
  const items = await Promise.all(
    itemsIn(c, a, b).map(async (it) => {
      const rc = c.r.clips.get(it.clip.id)!;
      const { label: _l, origin: _o, extra: _e, ...rest } = it.clip as Clip & { label?: string };
      const base = { ti: it.ti, clip: rest, s: +(it.start - a).toFixed(4), e: +(it.end - a).toFixed(4), in: rc.in, sp: rc.speed, keys: rc.keys };
      if (it.clip.type === 'media') return { ...base, file: c.media.get(it.clip.src)?.id };
      if (it.clip.type === 'generator' && typeof it.clip.params.image === 'string') return { ...base, file: c.media.get(it.clip.params.image)?.id };
      if (it.clip.type === 'comp') return { ...base, comp: await compHash(compDir(c.dir, (it.clip as CompClip).comp), { ...compOpts(c, it.clip as CompClip, it), v: 1 }).catch(() => 'missing') };
      return base;
    }),
  );
  const caps = c.p.tracks
    .map((t, ti) => ({ t, ti }))
    .filter(({ t }) => t.kind === 'captions' && !t.hidden && t.enabled !== false)
    .map(({ t, ti }) => ({ ti, style: t.style, ev: captionEvents(captionWords(c, t), c.end, Number((t.style as { y?: number })?.y ?? 1480), Number((t.style as { max_words?: number })?.max_words ?? 3), a, b) }));
  return sha({ v: RENDERER, W: c.W, H: c.H, fps: c.fps, len: b - a, regions: c.p.regions, blurs: c.p.blurs, items, caps });
}

function compOpts(c: Ctx, clip: CompClip, it: Item) {
  return { fps: c.fps, dur: +(it.end - it.start).toFixed(4), vars: c.r.clips.get(clip.id)?.vars ?? {}, width: c.W, height: c.H };
}

export interface PlanOut {
  segments: { t0: number; t1: number; cached: boolean; key: string }[];
  comps: { clip: string; comp: string; cached: boolean }[];
  output: string;
  estimate: string;
}

function outputOf(c: Ctx): string {
  const name = path.basename(c.dir).replace(/[^\w.-]/g, '_');
  return path.join(c.dir, 'renders', `${name}-r${c.p.revision}.mp4`);
}

export async function plan(dir: string): Promise<PlanOut> {
  const c = await context(dir);
  const comps: PlanOut['comps'] = [];
  for (const t of c.p.tracks)
    if (t.kind === 'graphics' && !t.hidden)
      for (const cl of t.clips) {
        if (cl.type !== 'comp') continue;
        const rc = c.r.clips.get(cl.id);
        if (!rc) continue;
        comps.push({ clip: cl.id, comp: cl.comp, cached: await compCached(dir, cl, compOpts(c, cl, { track: t, ti: 0, clip: cl, start: rc.start, end: rc.end ?? c.end })) });
      }
  const segments: PlanOut['segments'] = [];
  for (const [fa, fb] of segmentsOf(c)) {
    const a = fa / c.fps;
    const b = fb / c.fps;
    const key = await segmentKey(c, a, b);
    segments.push({ t0: a, t1: b, key, cached: await exists(path.join(c.work, `seg-${key}.mp4`)) });
  }
  const stale = segments.filter((s) => !s.cached).reduce((n, s) => n + (s.t1 - s.t0), 0);
  const compsTodo = comps.filter((x) => !x.cached).length;
  const est = stale * 0.5 + compsTodo * 20 + 3;
  return {
    segments,
    comps,
    output: outputOf(c),
    estimate: stale === 0 && compsTodo === 0 ? 'seconds (everything is cached, only joining)' : `about ${est < 90 ? `${Math.ceil(est)} s` : `${Math.ceil(est / 60)} min`} (${stale.toFixed(1)} s of picture${compsTodo ? `, ${compsTodo} comp render${compsTodo > 1 ? 's' : ''}` : ''})`,
  };
}

// --- rendering one segment -------------------------------------------------------------------------
async function backdrop(c: Ctx, c0: string, c1: string): Promise<string> {
  const file = path.join(c.work, `bg-${sha([c0, c1, c.W, c.H])}.png`);
  if (await exists(file)) return file;
  const k = c.k;
  await ff(['-f', 'lavfi', '-i', `gradients=s=${c.W}x${c.H}:c0=${c0}:c1=${c1}:x0=${Math.round(540 * k)}:y0=${Math.round(700 * k)}:x1=${Math.round(540 * k)}:y1=${Math.round(1920 * k)}:nb_colors=2:type=radial:d=1:r=1`, '-frames:v', '1', file]);
  return file;
}

const ffColor = (c: string | undefined, fallback: string) => `0x${hex(c, fallback)}`;

async function renderSegment(c: Ctx, a: number, b: number, out: string, tag: string): Promise<void> {
  const fa = F(a, c.fps);
  const n = F(b, c.fps) - fa;
  const dur = n / c.fps;
  const inputs: string[] = ['-f', 'lavfi', '-i', `color=c=black:s=${c.W}x${c.H}:r=${c.fps}:d=${(dur + 0.5).toFixed(3)}`];
  const graph: string[] = ['[0:v]format=yuv420p[v0]'];
  let v = 0;
  let ni = 1;
  const k = c.k;
  const assFiles: string[] = [];
  const over = (label: string, x: number, y: number, ca: number, cb: number) => {
    graph.push(`[v${v}][${label}]overlay=${Math.round(x)}:${Math.round(y)}:eof_action=pass:enable='between(t,${ca.toFixed(4)},${cb.toFixed(4)})'[v${v + 1}]`);
    v++;
  };
  // ASS layers are batched until something that isn't ASS (a video, a comp) has to go over them
  let ass: string[] = [];
  const flushAss = async () => {
    if (!ass.length) return;
    const name = `${tag}-${assFiles.length}.ass`;
    await fs.writeFile(path.join(c.work, name), '\ufeff' + assHeader(c.H / k) + ass.join('\n') + '\n', 'utf-8');
    assFiles.push(name);
    graph.push(`[v${v}]subtitles=filename=${name}[v${v + 1}]`);
    v++;
    ass = [];
  };

  for (const [ti, track] of c.p.tracks.entries()) {
    if (!visual(track)) continue;
    if (track.kind === 'captions') {
      if (track.enabled === false) continue;
      const st = (track.style ?? {}) as { y?: number; max_words?: number };
      ass.push(...captionEvents(captionWords(c, track), c.end, Math.round(Number(st.y ?? 1480)), Number(st.max_words ?? 3), a, b));
      continue;
    }
    let items = itemsIn(c, a, b).filter((x) => x.ti === ti);
    if (track.kind === 'graphics') items = items.sort((x, y) => layerOf(x.clip) - layerOf(y.clip));
    for (const it of items) {
      const cl = it.clip;
      const ca = Math.max(0, it.start - a);
      const cb = Math.min(dur, it.end - a);
      const off = Math.max(0, a - it.start); // seconds into the clip at the segment's start
      if (cl.type === 'title') {
        ass.push(titleEvent(cl, it.start - a, it.end - a));
        continue;
      }
      await flushAss();
      if (cl.type === 'generator') {
        const prm = cl.params as { c0?: string; c1?: string; image?: string; color?: string };
        if (cl.generator === 'radial-gradient') {
          inputs.push('-loop', '1', '-framerate', String(c.fps), '-t', (dur + 0.5).toFixed(3), '-i', await backdrop(c, ffColor(prm.c0, '16203A'), ffColor(prm.c1, '06080D')));
          graph.push(`[${ni}:v]format=yuva420p,setpts=PTS-STARTPTS+${ca.toFixed(4)}/TB[g${ni}]`);
        } else if (cl.generator === 'image' && prm.image && c.media.get(prm.image)?.exists) {
          inputs.push('-loop', '1', '-framerate', String(c.fps), '-t', (dur + 0.5).toFixed(3), '-i', c.media.get(prm.image)!.abs);
          graph.push(`[${ni}:v]scale=${c.W}:${c.H},format=yuva420p,setpts=PTS-STARTPTS+${ca.toFixed(4)}/TB[g${ni}]`);
        } else {
          inputs.push('-f', 'lavfi', '-i', `color=c=${ffColor(prm.color, '000000')}:s=${c.W}x${c.H}:r=${c.fps}:d=${(cb - ca + 0.5).toFixed(3)}`);
          graph.push(`[${ni}:v]format=yuva420p,setpts=PTS-STARTPTS+${ca.toFixed(4)}/TB[g${ni}]`);
        }
        over(`g${ni}`, 0, 0, ca, cb);
        ni++;
        continue;
      }
      if (cl.type === 'comp') {
        const rr = c.compRenders.get(cl.id);
        if (!rr?.file) continue;
        inputs.push('-ss', off.toFixed(4), '-t', (cb - ca + 0.5).toFixed(3), '-i', rr.file);
        graph.push(`[${ni}:v]scale=${c.W}:${c.H},format=yuva420p,setpts=PTS-STARTPTS+${ca.toFixed(4)}/TB[g${ni}]`);
        over(`g${ni}`, 0, 0, ca, cb);
        ni++;
        continue;
      }
      // media card
      const m = c.media.get(cl.src);
      if (!m?.exists) continue;
      const rc = c.r.clips.get(cl.id)!;
      const speed = rc.speed ?? 1;
      const still = cl.still || m.kind === 'image';
      const [rx, ry, rw, rh] = regionOf(c.p, cl, m);
      const cw = Math.round((cl.cardW ?? 1080) * k / 2) * 2;
      const ch = Math.round((cw * rh) / rw / 2) * 2;
      const keys = (rc.keys?.length ? rc.keys : [[0, 1, rw / 2, rh / 2]]).map((kk) => [kk[0]! - off, kk[1]!, kk[2]!, kk[3]!]);
      const z = keyed(keys, 1);
      const fx = keyed(keys, 2);
      const fy = keyed(keys, 3);
      const blur = blursOf(c.p, cl)
        .map(([bx, by, bw, bh]) => ({ x: Math.max(1, Math.round(bx - rx)), y: Math.max(1, Math.round(by - ry)), w: Math.round(bw), h: Math.round(bh) }))
        .filter((q) => q.x + q.w < rw - 1 && q.y + q.h < rh - 1)
        .map((q) => `,delogo=x=${q.x}:y=${q.y}:w=${q.w}:h=${q.h}`)
        .join('');
      if (still) inputs.push('-loop', '1', '-framerate', String(c.fps), '-t', (cb - ca + 0.5).toFixed(3), '-i', m.abs);
      else inputs.push('-ss', ((rc.in ?? 0) + off * speed).toFixed(4), '-t', ((cb - ca) * speed + 0.5).toFixed(3), '-i', m.abs);
      const fi = cl.fadeIn ?? 0;
      const fo = cl.fadeOut ?? 0;
      const clipDur = it.end - it.start;
      const fades =
        (fi > off ? `,fade=t=in:st=0:d=${(fi - off).toFixed(3)}:alpha=1` : '') +
        (fo > 0 ? `,fade=t=out:st=${Math.max(0, clipDur - fo - off).toFixed(3)}:d=${fo.toFixed(3)}:alpha=1` : '');
      const zp = `zoompan=z='${z}':x='clip(2*(${fx})-iw/zoom/2,0,iw-iw/zoom)':y='clip(2*(${fy})-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${cw}x${ch}:fps=${c.fps}`;
      graph.push(
        `[${ni}:v]crop=${Math.round(rw)}:${Math.round(rh)}:${Math.round(rx)}:${Math.round(ry)}${blur},setpts=(PTS-STARTPTS)/${speed},fps=${c.fps},` +
          `scale=${2 * Math.round(rw)}:${2 * Math.round(rh)}:flags=lanczos,${zp}` +
          (cl.dim ? ',boxblur=6:1,eq=brightness=-0.28' : '') +
          `,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.12:t=3,format=yuva420p${fades},setpts=PTS-STARTPTS+${ca.toFixed(4)}/TB[m${ni}]`,
      );
      over(`m${ni}`, (c.W - cw) / 2, (cl.cy ?? 900) * k - ch / 2, ca, cb);
      ni++;
    }
  }
  await flushAss();
  graph.push(`[v${v}]format=yuv420p[out]`);
  const script = path.join(c.work, `${tag}.filter`);
  await fs.writeFile(script, graph.join(';\n'), 'utf-8');
  const tmp = `${out}.tmp.mp4`;
  try {
    await ff([...inputs, '-/filter_complex', path.basename(script), '-map', '[out]', '-frames:v', String(n), '-r', String(c.fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(c.fps * 1000), '-an', tmp], c.work);
    await fs.rename(tmp, out);
  } finally {
    await fs.rm(script, { force: true });
    for (const f of assFiles) await fs.rm(path.join(c.work, f), { force: true });
  }
}

function layerOf(c: Clip) {
  if (c.type !== 'title') return 1;
  return c.layer ?? (c.shape ? 2 : c.style === 'Tag' ? 3 : 1);
}

function regionOf(p: Project, c: MediaClip, m: MediaInfo): [number, number, number, number] {
  const r = c.region;
  if (Array.isArray(r)) return r;
  if (typeof r === 'string' && p.regions[r]) return p.regions[r]!;
  return [0, 0, m.width ?? 1080, m.height ?? 1920];
}

function blursOf(p: Project, c: MediaClip): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const b of c.blur ?? []) {
    const v = typeof b === 'string' ? p.blurs[b] : b;
    if (!v) continue;
    if (Array.isArray(v[0])) out.push(...(v as [number, number, number, number][]));
    else out.push(v as [number, number, number, number]);
  }
  return out;
}

// --- sound ---------------------------------------------------------------------------------------
async function mix(c: Ctx, log: (m: string) => void): Promise<{ file: string; gainDb: number }> {
  const clips: { c: MediaClip; t: Track; start: number; end: number; inPt: number; speed: number; db: number }[] = [];
  for (const t of c.p.tracks) {
    if (t.kind !== 'audio' || t.muted) continue;
    for (const cl of t.clips) {
      if (cl.type !== 'media') continue;
      const rc = c.r.clips.get(cl.id);
      const m = c.media.get(cl.src);
      if (!rc || !m?.exists) continue;
      let end = rc.end ?? (m.duration !== undefined ? rc.start + (m.duration - (rc.in ?? 0)) / (rc.speed ?? 1) : c.end);
      end = Math.min(end, c.end);
      if (end <= rc.start) continue;
      let db = (cl.gain ?? (t.role === 'sfx' ? -10 : t.role === 'music' ? -22 : 0)) + (t.gain ?? 0);
      if (t.role === 'voice') {
        const pk = await peaks(m.abs, cacheOf(c.dir)).catch(() => null);
        if (pk?.lufs != null) db += Math.max(-12, Math.min(12, -13.5 - pk.lufs));
      }
      clips.push({ c: cl, t, start: rc.start, end, inPt: rc.in ?? 0, speed: rc.speed ?? 1, db });
    }
  }
  const key = sha({ v: RENDERER, end: c.end, master: c.p.master, clips: clips.map((x) => ({ ...x, t: x.t.id, file: c.media.get(x.c.src)?.id })) });
  const file = path.join(c.work, `audio-${key}.flac`);
  const meta = `${file}.json`;
  if ((await exists(file)) && (await exists(meta))) return { file, gainDb: (JSON.parse(await fs.readFile(meta, 'utf-8')) as { gainDb: number }).gainDb };
  log(`mixing sound (${clips.length} clips)`);
  const inputs: string[] = ['-f', 'lavfi', '-t', c.end.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
  const graph: string[] = [];
  const labels = ['[0:a]'];
  clips.forEach((x, i) => {
    const n = i + 1;
    const len = x.end - x.start;
    if (x.c.loop) inputs.push('-stream_loop', '-1', '-i', c.media.get(x.c.src)!.abs);
    else inputs.push('-ss', x.inPt.toFixed(4), '-t', (len * x.speed + 0.05).toFixed(4), '-i', c.media.get(x.c.src)!.abs);
    const tempo = x.speed === 1 ? '' : atempo(x.speed);
    const fi = x.c.fadeIn ?? (x.c.loop ? 0.05 : 0);
    const fo = x.c.fadeOut ?? (x.c.loop ? 1.3 : 0);
    const fades = (fi > 0 ? `,afade=t=in:st=0:d=${fi.toFixed(3)}` : '') + (fo > 0 ? `,afade=t=out:st=${Math.max(0, len - fo).toFixed(3)}:d=${fo.toFixed(3)}` : '');
    const ms = Math.max(0, Math.round(x.start * 1000));
    graph.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo${tempo},atrim=0:${len.toFixed(4)},asetpts=PTS-STARTPTS${fades},volume=${x.db.toFixed(2)}dB,adelay=${ms}:all=1[a${n}]`);
    labels.push(`[a${n}]`);
  });
  graph.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first,apad=whole_dur=${c.end.toFixed(3)},atrim=0:${c.end.toFixed(3)}[out]`);
  const script = path.join(c.work, `mix-${key}.filter`);
  await fs.writeFile(script, graph.join(';\n'), 'utf-8');
  const tmp = `${file}.tmp.flac`;
  try {
    await ff([...inputs, '-/filter_complex', path.basename(script), '-map', '[out]', '-c:a', 'flac', tmp], c.work);
  } finally {
    await fs.rm(script, { force: true });
  }
  await fs.rename(tmp, file);
  // loudness: measure the mix, then one static gain to the target (no pumping), limiter after
  const target = c.p.master?.loudness ?? -14;
  const measured = await integratedLufs(file);
  const gainDb = measured === null ? 0 : Math.max(-20, Math.min(20, target - measured));
  await fs.writeFile(meta, JSON.stringify({ measured, target, gainDb }), 'utf-8');
  return { file, gainDb };
}

function atempo(speed: number): string {
  const parts: number[] = [];
  let s = speed;
  while (s > 2) {
    parts.push(2);
    s /= 2;
  }
  while (s < 0.5) {
    parts.push(0.5);
    s /= 0.5;
  }
  parts.push(s);
  return parts.map((x) => `,atempo=${x.toFixed(5)}`).join('');
}

async function integratedLufs(file: string): Promise<number | null> {
  try {
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { maxBuffer: 64 << 20 });
    const m = /I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(stderr) ?? [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v > -70 ? v : null;
  } catch {
    return null;
  }
}

// --- jobs ----------------------------------------------------------------------------------------
export interface Job {
  id: string;
  state: 'planning' | 'rendering' | 'done' | 'failed';
  progress: number;
  message: string;
  output?: string;
  error?: string;
  took?: number;
  reused?: number;
  rendered?: number;
}

const jobs = new Map<string, Job>();
const running = new Set<string>();

export function jobOf(id: string) {
  return jobs.get(id);
}

/** Start an export (or an exact check render of a range). Progress goes to the editor as events. */
export function startExport(dir: string, range?: [number, number]): Job {
  const key = path.resolve(dir).toLowerCase();
  if (running.has(key)) throw new Error('an export of this project is already running');
  const job: Job = { id: Math.random().toString(36).slice(2, 10), state: 'planning', progress: 0, message: 'planning' };
  jobs.set(job.id, job);
  running.add(key);
  const t0 = Date.now();
  const update = (patch: Partial<Job>) => {
    Object.assign(job, patch);
    broadcast(dir, { type: 'export', job });
  };
  void (async () => {
    try {
      const out = await doExport(dir, range, update);
      update({ state: 'done', progress: 1, message: `done: ${path.basename(out.file)}`, output: out.file, took: (Date.now() - t0) / 1000, reused: out.reused, rendered: out.rendered });
    } catch (e) {
      update({ state: 'failed', message: 'export failed', error: (e as Error).message.slice(0, 3000) });
    } finally {
      running.delete(key);
    }
  })();
  return job;
}

/** Wait for a job to finish (for Claude's export tool). */
export async function waitFor(id: string, timeoutMs: number): Promise<Job | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = jobs.get(id);
    if (!j || j.state === 'done' || j.state === 'failed') return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  return jobs.get(id);
}

async function doExport(dir: string, range: [number, number] | undefined, update: (p: Partial<Job>) => void) {
  const c = await context(dir);
  const log = (m: string) => update({ message: m });
  // 1. comps
  const compItems: { clip: CompClip; it: Item }[] = [];
  for (const [ti, t] of c.p.tracks.entries())
    if (t.kind === 'graphics' && !t.hidden)
      for (const cl of t.clips) {
        const rc = c.r.clips.get(cl.id);
        if (cl.type !== 'comp' || !rc) continue;
        const it = { track: t, ti, clip: cl, start: rc.start, end: rc.end ?? c.end };
        if (range && (it.end <= range[0] || it.start >= range[1])) continue;
        compItems.push({ clip: cl, it });
      }
  update({ state: 'rendering', progress: 0.02 });
  for (const [i, x] of compItems.entries()) {
    try {
      const r = await renderComp(dir, x.clip, compOpts(c, x.clip, x.it), log);
      c.compRenders.set(x.clip.id, r);
    } catch (e) {
      throw new Error(`comp ${x.clip.id} (${x.clip.comp}) didn't render: ${(e as Error).message}`);
    }
    update({ progress: 0.02 + 0.3 * ((i + 1) / Math.max(1, compItems.length)) });
  }
  // 2. sound
  const sound = await mix(c, log);
  update({ progress: 0.4 });
  // 3. picture
  let reused = 0;
  let rendered = 0;
  const pieces: string[] = [];
  let segs: [number, number][];
  if (range) segs = [[F(range[0], c.fps), F(range[1], c.fps)]];
  else segs = segmentsOf(c);
  for (const [i, [fa, fb]] of segs.entries()) {
    const a = fa / c.fps;
    const b = fb / c.fps;
    const key = await segmentKey(c, a, b);
    const file = path.join(c.work, range ? `check-${key}.mp4` : `seg-${key}.mp4`);
    if (await exists(file)) reused++;
    else {
      log(`rendering ${a.toFixed(1)}–${b.toFixed(1)} s (${i + 1} of ${segs.length})`);
      await renderSegment(c, a, b, file, `seg-${key}`);
      rendered++;
    }
    pieces.push(file);
    update({ progress: 0.4 + 0.55 * ((i + 1) / segs.length) });
  }
  // 4. join + sound
  log('joining');
  const list = path.join(c.work, `concat-${Date.now()}.txt`);
  await fs.writeFile(list, pieces.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''), 'utf-8');
  const name = path.basename(c.dir).replace(/[^\w.-]/g, '_');
  const outDir = path.join(c.dir, 'renders');
  await fs.mkdir(outDir, { recursive: true });
  const file = range ? path.join(outDir, `${name}-check-${range[0].toFixed(1)}-${range[1].toFixed(1)}.mp4`) : outputOf(c);
  const a0 = range ? F(range[0], c.fps) / c.fps : 0;
  const len = range ? (F(range[1], c.fps) - F(range[0], c.fps)) / c.fps : F(c.end, c.fps) / c.fps;
  try {
    await ff([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-ss', a0.toFixed(4), '-i', sound.file,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      '-af', `volume=${sound.gainDb.toFixed(2)}dB,alimiter=limit=0.89:level=false`,
      '-c:a', 'aac', '-b:a', '192k', '-t', len.toFixed(4), '-movflags', '+faststart', file,
    ]);
  } finally {
    await fs.rm(list, { force: true });
  }
  return { file, reused, rendered };
}

// --- OpenTimelineIO ----------------------------------------------------------------------------
/** The edit as .otio, to finish in DaVinci Resolve (media clips; comps as their rendered .mov). */
export async function exportOtio(dir: string): Promise<string> {
  const c = await context(dir);
  const rate = c.fps;
  const rt = (sec: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: Math.round(sec * rate) });
  const range = (start: number, dur: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(dur) });
  const otioTracks: unknown[] = [];
  const url = (abs: string) => 'file:///' + abs.replace(/\\/g, '/');
  for (const t of c.p.tracks) {
    if (t.kind === 'captions') continue;
    const kind = t.kind === 'audio' ? 'Audio' : 'Video';
    const items = t.clips
      .map((cl) => ({ cl, rc: c.r.clips.get(cl.id) }))
      .filter((x) => x.rc && (x.cl.type === 'media' || x.cl.type === 'comp'))
      .map((x) => {
        const rc = x.rc!;
        let end = rc.end;
        if (end === null && x.cl.type === 'media') {
          const m = c.media.get(x.cl.src);
          end = m?.duration !== undefined ? rc.start + (m.duration - (rc.in ?? 0)) / (rc.speed ?? 1) : c.end;
        }
        return { ...x, start: rc.start, end: Math.min(end ?? c.end, c.end) };
      })
      .filter((x) => x.end > x.start)
      .sort((a, b) => a.start - b.start);
    // OTIO tracks can't overlap: pack into lanes
    const lanes: (typeof items)[] = [];
    for (const it of items) {
      const lane = lanes.find((l) => l[l.length - 1]!.end <= it.start + 1e-4);
      if (lane) lane.push(it);
      else lanes.push([it]);
    }
    for (const [li, lane] of lanes.entries()) {
      const children: unknown[] = [];
      let at = 0;
      for (const it of lane) {
        if (it.start - at > 1 / rate / 2) children.push({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: range(0, it.start - at) });
        const speed = it.rc!.speed ?? 1;
        let target: string;
        let srcStart: number;
        if (it.cl.type === 'media') {
          target = c.media.get(it.cl.src)?.abs ?? path.resolve(dir, it.cl.src);
          srcStart = it.rc!.in ?? 0;
        } else {
          const cc = it.cl as CompClip;
          const key = await compHash(compDir(dir, cc.comp), { ...compOpts(c, cc, { track: t, ti: 0, clip: cc, start: it.start, end: it.end }), v: 1 }).catch(() => '');
          const file = path.join(cacheOf(dir), 'renders', `comp-${key}.mov`);
          target = key && (await exists(file)) ? file : path.join(dir, cc.comp, 'index.html');
          srcStart = 0;
        }
        children.push({
          OTIO_SCHEMA: 'Clip.2',
          name: it.cl.label ?? it.cl.id,
          source_range: range(srcStart, (it.end - it.start) * speed),
          effects: speed !== 1 ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', name: 'speed', effect_name: 'LinearTimeWarp', time_scalar: speed }] : [],
          media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: 'ExternalReference.1', target_url: url(target) } },
          active_media_reference_key: 'DEFAULT_MEDIA',
          metadata: { mangoai: { id: it.cl.id, track: t.id, ...(it.cl.type === 'media' && it.cl.gain !== undefined && { gain_db: it.cl.gain }) } },
        });
        at = it.end;
      }
      otioTracks.push({ OTIO_SCHEMA: 'Track.1', name: lanes.length > 1 ? `${t.id}.${li + 1}` : t.id, kind, children, metadata: { mangoai: { role: t.role } } });
   }
  }
  const video = otioTracks.filter((x) => (x as { kind: string }).kind === 'Video');
  const audio = otioTracks.filter((x) => (x as { kind: string }).kind === 'Audio');
  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    name: c.p.title ?? path.basename(dir),
    global_start_time: rt(0),
    tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: [...video, ...audio] },
    metadata: { mangoai: { revision: c.p.revision, width: c.W, height: c.H, fps: c.fps } },
  };
  const out = path.join(dir, 'renders', `${path.basename(dir).replace(/[^\w.-]/g, '_')}-r${c.p.revision}.otio`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(timeline, null, 2), 'utf-8');
  return out;
}
