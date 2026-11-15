// cut.json: the MangoAI project file. The timeline as data, nothing else (no words, no waveforms), so it
// stays small and diff-friendly even for a 50-minute edit. See docs/PROJECT_FORMAT.md.
import { z } from 'zod';

export const FORMAT = 'mangoai/cut';
export const FORMAT_VERSION = 1;

/** A time: seconds, or an expression string such as "word:this#2 - 0.06" (see time.ts). */
export const TimeExpr = z.union([z.number().finite(), z.string().min(1)]);
export type TimeExpr = z.infer<typeof TimeExpr>;

const Id = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/, 'ids use letters, digits, _ . : -');
/** Names usable as terms in time expressions (anchors, sections). */
const Name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'names start with a letter or _, then letters, digits, _ -');
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Extra = z.record(z.unknown());

/** [time, zoom, focus x, focus y]; time may use the clip-local terms `start` and `dur`. */
export const ZoomKey = z.tuple([TimeExpr, z.number(), z.number(), z.number()]);

const ClipBase = {
  id: Id,
  start: TimeExpr,
  /** Omitted = runs to the end of its media (audio) or must be given (everything else). */
  end: TimeExpr.optional(),
  /** Seconds into the clip that sit exactly at `start` (an SFX's loudest point). Default 0. */
  pivot: z.number().optional(),
  label: z.string().optional(),
  /** Where an imported clip came from, so it can be written back losslessly (e.g. "sfx:3/at:1"). */
  origin: z.string().optional(),
  extra: Extra.optional(),
};

export const MediaClip = z
  .object({
    ...ClipBase,
    type: z.literal('media'),
    /** A name from `sources`, or a path relative to the project folder. */
    src: z.string().min(1),
    /** Where to start in the source (seconds or expression). */
    in: TimeExpr.optional(),
    speed: z.number().positive().optional(),
    /** Fit this source span exactly into the clip: [from, to]. */
    speedTo: z.tuple([TimeExpr, TimeExpr]).optional(),
    still: z.boolean().optional(),
    region: z.union([z.string(), Rect]).optional(),
    blur: z.array(z.union([z.string(), Rect])).optional(),
    /** Card placement in the frame: width and centre y (1080-wide vertical layout). */
    cardW: z.number().optional(),
    cy: z.number().optional(),
    dim: z.boolean().optional(),
    keys: z.array(ZoomKey).optional(),
    /** dB. */
    gain: z.number().optional(),
    loop: z.boolean().optional(),
  })
  .strict();

export const GeneratorClip = z
  .object({
    ...ClipBase,
    type: z.literal('generator'),
    generator: z.enum(['radial-gradient', 'color', 'image']),
    params: Extra,
  })
  .strict();

/** A text/shape graphic drawn by the built-in title renderer (short.json "graphics"). */
export const TitleClip = z
  .object({
    ...ClipBase,
    type: z.literal('title'),
    style: z.string().optional(),
    pos: z.tuple([z.number(), z.number()]).optional(),
    text: z.string().optional(),
    runs: z.array(z.tuple([z.string(), z.string()])).optional(),
    fs: z.number().optional(),
    bold: z.boolean().optional(),
    color: z.string().optional(),
    box: z.string().optional(),
    strike: z.boolean().optional(),
    pop: z.boolean().optional(),
    fade: z.tuple([z.number(), z.number()]).optional(),
    shape: Extra.optional(),
    layer: z.number().optional(),
  })
  .strict();

/** A HyperFrames composition (a folder with index.html), placed as one clip. */
export const CompClip = z
  .object({
    ...ClipBase,
    type: z.literal('comp'),
    comp: z.string().min(1),
    /** Values passed into the comp; times may be expressions, resolved by MangoAI. */
    vars: z.record(z.union([TimeExpr, z.boolean(), z.null()])).optional(),
  })
  .strict();

export const Clip = z.discriminatedUnion('type', [MediaClip, GeneratorClip, TitleClip, CompClip]);
export type Clip = z.infer<typeof Clip>;
export type MediaClip = z.infer<typeof MediaClip>;
export type TitleClip = z.infer<typeof TitleClip>;
export type GeneratorClip = z.infer<typeof GeneratorClip>;
export type CompClip = z.infer<typeof CompClip>;

export const TrackKind = z.enum(['video', 'graphics', 'captions', 'audio']);
export type TrackKind = z.infer<typeof TrackKind>;

export const Track = z
  .object({
    id: Id,
    kind: TrackKind,
    name: z.string().optional(),
    /** Audio tracks: what the track carries (drives default mixing such as ducking). */
    role: z.enum(['voice', 'sfx', 'music', 'other']).optional(),
    /** dB. */
    gain: z.number().optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    /** Captions tracks: which transcript, and how to draw it. */
    transcript: z.string().optional(),
    style: Extra.optional(),
    enabled: z.boolean().optional(),
    clips: z.array(Clip),
    extra: Extra.optional(),
  })
  .strict();
export type Track = z.infer<typeof Track>;

export const Section = z
  .object({
    id: Name,
    /** Sections run back to back: each starts where the previous one ends. */
    end: TimeExpr,
    note: z.string().optional(),
    extra: Extra.optional(),
  })
  .strict();
export type Section = z.infer<typeof Section>;

export const Anchor = z.object({ name: Name, at: TimeExpr }).strict();
export type Anchor = z.infer<typeof Anchor>;

export const Project = z
  .object({
    format: z.literal(FORMAT),
    version: z.literal(FORMAT_VERSION),
    /** Goes up by one on every save. */
    revision: z.number().int().nonnegative(),
    title: z.string().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    /** name -> words.tsv path. The first one is what `word:` terms read. */
    transcripts: z.record(z.string()),
    sources: z.record(z.string()),
    regions: z.record(Rect),
    blurs: z.record(z.union([Rect, z.array(Rect)])),
    /** Named times, resolved top to bottom (later ones may use earlier ones). */
    anchors: z.array(Anchor),
    sections: z.array(Section),
    tracks: z.array(Track),
    master: z.object({ loudness: z.number().optional(), limiter: z.number().optional() }).strict().optional(),
    /** Fields kept from an import that MangoAI does not model yet. */
    extra: Extra.optional(),
  })
  .strict();
export type Project = z.infer<typeof Project>;

export interface Problem {
  path: string;
  message: string;
}

/** Full check of a project: shape plus the rules the schema can't express. Run on load and save. */
export function validateProject(data: unknown): { ok: true; project: Project } | { ok: false; problems: Problem[] } {
  const parsed = Project.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const p = parsed.data;
  const problems: Problem[] = [];
  const ids = new Set<string>();
  const trackIds = new Set<string>();
  p.tracks.forEach((t, ti) => {
    if (trackIds.has(t.id)) problems.push({ path: `tracks.${ti}.id`, message: `duplicate track id ${t.id}` });
    trackIds.add(t.id);
    t.clips.forEach((c, ci) => {
      if (ids.has(c.id)) problems.push({ path: `tracks.${ti}.clips.${ci}.id`, message: `duplicate clip id ${c.id}` });
      ids.add(c.id);
      if (!clipAllowedOn(c, t.kind))
        problems.push({ path: `tracks.${ti}.clips.${ci}`, message: `a ${c.type} clip can't go on a ${t.kind} track` });
      if (c.end === undefined && !(c.type === 'media' && t.kind === 'audio'))
        problems.push({ path: `tracks.${ti}.clips.${ci}.end`, message: 'only audio clips may leave out end' });
    });
    if (t.kind === 'captions' && t.clips.length > 0)
      problems.push({ path: `tracks.${ti}.clips`, message: 'captions tracks draw from a transcript and hold no clips' });
  });
  const names = new Set<string>();
  for (const [i, a] of p.anchors.entries()) {
    if (names.has(a.name)) problems.push({ path: `anchors.${i}.name`, message: `duplicate name ${a.name}` });
    names.add(a.name);
  }
  for (const [i, s] of p.sections.entries()) {
    if (names.has(s.id)) problems.push({ path: `sections.${i}.id`, message: `name ${s.id} is already used` });
    names.add(s.id);
  }
  return problems.length ? { ok: false, problems } : { ok: true, project: p };
}

export function clipAllowedOn(clip: Clip, kind: TrackKind): boolean {
  switch (kind) {
    case 'video':
      return clip.type === 'media' || clip.type === 'generator';
    case 'graphics':
      return clip.type === 'title' || clip.type === 'comp';
    case 'audio':
      return clip.type === 'media';
    case 'captions':
      return false;
  }
}

export function emptyProject(opts: { width?: number; height?: number; fps?: number; title?: string } = {}): Project {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    revision: 0,
    ...(opts.title !== undefined && { title: opts.title }),
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
    fps: opts.fps ?? 30,
    transcripts: {},
    sources: {},
    regions: {},
    blurs: {},
    anchors: [],
    sections: [],
    tracks: [],
  };
}
