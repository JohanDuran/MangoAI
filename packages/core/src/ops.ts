// Every change to a project, from the mouse or from Claude, is a list of small ops. Ops mutate the project
// in place through an index (so a drag on a 2,000-clip timeline doesn't copy anything), and each applied op
// records its exact inverse. Undo history is ops, never snapshots.
import { Anchor, Clip, clipAllowedOn, Section, Track, type Project, type TimeExpr } from './schema.js';
import { resolveProject, type Resolved, type ResolveOptions } from './resolve.js';
import { round4 } from './time.js';

/** `null` in a `set` removes that field. */
type Patch<T> = { [K in keyof T]?: T[K] | null };

export type Op =
  | { op: 'add_track'; track: Track; index?: number }
  | { op: 'remove_track'; id: string }
  | { op: 'update_track'; id: string; set: Patch<Omit<Track, 'id' | 'clips' | 'kind'>> }
  | { op: 'add_clip'; track: string; clip: Clip; index?: number }
  | { op: 'remove_clip'; id: string }
  | { op: 'update_clip'; id: string; set: Record<string, unknown> }
  | { op: 'move_clip'; id: string; track: string; index?: number }
  | { op: 'split_clip'; id: string; at: number; newId: string }
  | { op: 'set_anchor'; name: string; at: TimeExpr | null; index?: number }
  | { op: 'add_section'; section: Section; index?: number }
  | { op: 'remove_section'; id: string }
  | { op: 'update_section'; id: string; set: Patch<Omit<Section, 'id'>> }
  | { op: 'set_title'; title: string | null };

export type Author = 'you' | 'claude';

export interface Change {
  author: Author;
  label: string;
  ops: Op[];
  /** Applied in order, these undo `ops`. */
  inverse: Op[];
  /** One plain sentence per op, for history.jsonl and Claude's "what changed" summary. */
  summary: string[];
  at: string;
}

export class OpError extends Error {}

interface ClipLoc {
  track: Track;
  index: number;
}

export class Editor {
  readonly project: Project;
  private clipIndex = new Map<string, ClipLoc>();
  private trackIndex = new Map<string, Track>();
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private resolved: Resolved | null = null;
  /** Goes up on every applied change; cheap "did anything change" check for views. */
  version = 0;

  constructor(project: Project, private readonly resolveOpts: ResolveOptions = {}) {
    this.project = project;
    this.reindex();
  }

  // --- reading ----------------------------------------------------------------------------
  clip(id: string): Clip | undefined {
    const loc = this.clipIndex.get(id);
    return loc?.track.clips[loc.index];
  }

  trackOf(clipId: string): Track | undefined {
    return this.clipIndex.get(clipId)?.track;
  }

  track(id: string): Track | undefined {
    return this.trackIndex.get(id);
  }

  /** Resolved times, cached until the next change. */
  resolve(): Resolved {
    return (this.resolved ??= resolveProject(this.project, this.resolveOpts));
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get history(): readonly Change[] {
    return this.undoStack;
  }

  // --- writing ----------------------------------------------------------------------------
  /** Apply ops as one change (all or nothing). Returns the change that went on the undo stack. */
  apply(ops: Op[], meta: { author: Author; label?: string }): Change {
    const inverse: Op[] = [];
    const summary: string[] = [];
    try {
      for (const op of ops) {
        summary.push(this.describe(op));
        inverse.unshift(...this.applyOne(op));
      }
    } catch (e) {
      for (const inv of inverse) this.applyOne(inv);
      this.touch();
      throw e;
    }
    this.touch();
    const change: Change = {
      author: meta.author,
      label: meta.label ?? summary[0] ?? 'change',
      ops,
      inverse,
      summary,
      at: new Date().toISOString(),
    };
    this.undoStack.push(change);
    this.redoStack = [];
    return change;
  }

  undo(): Change | undefined {
    const c = this.undoStack.pop();
    if (!c) return undefined;
    for (const op of c.inverse) this.applyOne(op);
    this.touch();
    this.redoStack.push(c);
    return c;
  }

  redo(): Change | undefined {
    const c = this.redoStack.pop();
    if (!c) return undefined;
    for (const op of c.ops) this.applyOne(op);
    this.touch();
    this.undoStack.push(c);
    return c;
  }

  // --- internals --------------------------------------------------------------------------
  private touch() {
    this.version++;
    this.resolved = null;
  }

  private reindex() {
    this.clipIndex.clear();
    this.trackIndex.clear();
    for (const t of this.project.tracks) {
      this.trackIndex.set(t.id, t);
      this.reindexTrack(t, 0);
    }
  }

  private reindexTrack(t: Track, from: number) {
    for (let i = from; i < t.clips.length; i++) this.clipIndex.set(t.clips[i]!.id, { track: t, index: i });
  }

  private needTrack(id: string): Track {
    const t = this.trackIndex.get(id);
    if (!t) throw new OpError(`no track ${id}`);
    return t;
  }

  private needClip(id: string): ClipLoc & { clip: Clip } {
    const loc = this.clipIndex.get(id);
    if (!loc) throw new OpError(`no clip ${id}`);
    return { ...loc, clip: loc.track.clips[loc.index]! };
  }

  private insertClip(t: Track, clip: Clip, index?: number): number {
    if (this.clipIndex.has(clip.id)) throw new OpError(`clip id ${clip.id} is already used`);
    if (!clipAllowedOn(clip, t.kind)) throw new OpError(`a ${clip.type} clip can't go on ${t.kind} track ${t.id}`);
    const i = index === undefined ? t.clips.length : Math.max(0, Math.min(index, t.clips.length));
    t.clips.splice(i, 0, clip);
    this.reindexTrack(t, i);
    return i;
  }

  private takeClip(id: string): { track: Track; index: number; clip: Clip } {
    const { track, index, clip } = this.needClip(id);
    track.clips.splice(index, 1);
    this.clipIndex.delete(id);
    this.reindexTrack(track, index);
    return { track, index, clip };
  }

  /** Applies one op and returns the ops that undo it, in the order to apply them. */
  private applyOne(op: Op): Op[] {
    const inv = this.applyOneInner(op);
    return Array.isArray(inv) ? inv : [inv];
  }

  private applyOneInner(op: Op): Op | Op[] {
    const p = this.project;
    switch (op.op) {
      case 'add_track': {
        const track = Track.parse(op.track);
        if (this.trackIndex.has(track.id)) throw new OpError(`track id ${track.id} is already used`);
        for (const c of track.clips) if (this.clipIndex.has(c.id)) throw new OpError(`clip id ${c.id} is already used`);
        const i = op.index === undefined ? p.tracks.length : Math.max(0, Math.min(op.index, p.tracks.length));
        p.tracks.splice(i, 0, track);
        this.trackIndex.set(track.id, track);
        this.reindexTrack(track, 0);
        return { op: 'remove_track', id: track.id };
      }
      case 'remove_track': {
        const t = this.needTrack(op.id);
        const i = p.tracks.indexOf(t);
        p.tracks.splice(i, 1);
        this.trackIndex.delete(t.id);
        for (const c of t.clips) this.clipIndex.delete(c.id);
        return { op: 'add_track', track: t, index: i };
      }
      case 'update_track': {
        const t = this.needTrack(op.id);
        const before = patchObject(t as unknown as Record<string, unknown>, op.set, ['id', 'clips', 'kind']);
        Track.parse(t);
        return { op: 'update_track', id: t.id, set: before };
      }
      case 'add_clip': {
        const clip = Clip.parse(op.clip);
        this.insertClip(this.needTrack(op.track), clip, op.index);
        return { op: 'remove_clip', id: clip.id };
      }
      case 'remove_clip': {
        const { track, index, clip } = this.takeClip(op.id);
        return { op: 'add_clip', track: track.id, clip, index };
      }
      case 'update_clip': {
        const { clip, track } = this.needClip(op.id);
        const copy = { ...clip } as Record<string, unknown>;
        patchObject(copy, op.set, ['id', 'type']);
        const parsed = Clip.safeParse(copy);
        if (!parsed.success) throw new OpError(`update_clip ${op.id}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
        if (!clipAllowedOn(parsed.data, track.kind)) throw new OpError(`update_clip ${op.id}: not allowed on ${track.kind}`);
        const before = patchObject(clip as unknown as Record<string, unknown>, op.set, ['id', 'type']);
        return { op: 'update_clip', id: op.id, set: before };
      }
      case 'move_clip': {
        const to = this.needTrack(op.track);
        const { clip } = this.needClip(op.id);
        if (!clipAllowedOn(clip, to.kind)) throw new OpError(`a ${clip.type} clip can't go on ${to.kind} track ${to.id}`);
        const from = this.takeClip(op.id);
        this.insertClip(to, clip, op.index);
        return { op: 'move_clip', id: op.id, track: from.track.id, index: from.index };
      }
      case 'split_clip': {
        const { clip, track, index } = this.needClip(op.id);
        const r = this.resolve().clips.get(op.id);
        if (!r || r.end === null) throw new OpError(`split_clip ${op.id}: its times don't resolve`);
        if (!(op.at > r.start && op.at < r.end)) throw new OpError(`split_clip ${op.id}: ${op.at} s is outside the clip`);
        if (clip.pivot) throw new OpError(`split_clip ${op.id}: clips with a pivot (SFX hits) can't be split`);
        const second = structuredClone(clip) as Clip & Record<string, unknown>;
        second.id = op.newId;
        second.start = op.at;
        delete second.origin;
        if (second.type === 'media') {
          const offset = (op.at - r.start) * (r.speed ?? 1);
          second.in = round4((r.in ?? 0) + offset);
          second.speed = r.speed ?? 1;
          delete second.speedTo;
          if (second.speed === 1) delete second.speed;
          if (r.keys) delete second.keys; // zoom moves are kept on the first half only for now
        }
        const before = { end: clip.end ?? null } as Record<string, unknown>;
        this.insertClip(track, Clip.parse(second), index + 1);
        clip.end = op.at;
        // undo: drop the second half, then give the first its old end back
        return [
          { op: 'remove_clip', id: op.newId },
          { op: 'update_clip', id: clip.id, set: before },
        ];
      }
      case 'set_anchor': {
        const i = p.anchors.findIndex((a) => a.name === op.name);
        if (op.at === null) {
          if (i < 0) throw new OpError(`no anchor ${op.name}`);
          const [old] = p.anchors.splice(i, 1);
          return { op: 'set_anchor', name: op.name, at: old!.at, index: i };
        }
        const a = Anchor.parse({ name: op.name, at: op.at });
        if (i >= 0) {
          const old = p.anchors[i]!.at;
          p.anchors[i] = a;
          return { op: 'set_anchor', name: op.name, at: old };
        }
        if (p.sections.some((s) => s.id === op.name)) throw new OpError(`name ${op.name} is already a section`);
        const at = op.index === undefined ? p.anchors.length : op.index;
        p.anchors.splice(at, 0, a);
        return { op: 'set_anchor', name: op.name, at: null };
      }
      case 'add_section': {
        const s = Section.parse(op.section);
        if (p.sections.some((x) => x.id === s.id) || p.anchors.some((a) => a.name === s.id))
          throw new OpError(`name ${s.id} is already used`);
        const i = op.index === undefined ? p.sections.length : op.index;
        p.sections.splice(i, 0, s);
        return { op: 'remove_section', id: s.id };
      }
      case 'remove_section': {
        const i = p.sections.findIndex((s) => s.id === op.id);
        if (i < 0) throw new OpError(`no section ${op.id}`);
        const [s] = p.sections.splice(i, 1);
        return { op: 'add_section', section: s!, index: i };
      }
      case 'update_section': {
        const s = p.sections.find((x) => x.id === op.id);
        if (!s) throw new OpError(`no section ${op.id}`);
        const before = patchObject(s as unknown as Record<string, unknown>, op.set, ['id']);
        Section.parse(s);
        return { op: 'update_section', id: op.id, set: before };
      }
      case 'set_title': {
        const old = p.title ?? null;
        if (op.title === null) delete p.title;
        else p.title = op.title;
        return { op: 'set_title', title: old };
      }
    }
  }

  describe(op: Op): string {
    const name = (id: string) => {
      const c = this.clip(id);
      return c ? `${c.label ?? c.type} ${id}` : id;
    };
    switch (op.op) {
      case 'add_track':
        return `added ${op.track.kind} track ${op.track.id}`;
      case 'remove_track':
        return `removed track ${op.id}`;
      case 'update_track':
        return `changed track ${op.id}: ${Object.keys(op.set).join(', ')}`;
      case 'add_clip':
        return `added ${op.clip.type} clip ${op.clip.id} on ${op.track}`;
      case 'remove_clip':
        return `removed ${name(op.id)}`;
      case 'update_clip':
        return `changed ${name(op.id)}: ${Object.entries(op.set)
          .map(([k, v]) => `${k} → ${v === null ? '(none)' : JSON.stringify(v)}`)
          .join(', ')}`;
      case 'move_clip':
        return `moved ${name(op.id)} to track ${op.track}`;
      case 'split_clip':
        return `split ${name(op.id)} at ${op.at} s`;
      case 'set_anchor':
        return op.at === null ? `removed anchor ${op.name}` : `set anchor ${op.name} to ${JSON.stringify(op.at)}`;
      case 'add_section':
        return `added section ${op.section.id}`;
      case 'remove_section':
        return `removed section ${op.id}`;
      case 'update_section':
        return `changed section ${op.id}: ${Object.keys(op.set).join(', ')}`;
      case 'set_title':
        return `set the title to ${JSON.stringify(op.title)}`;
    }
  }
}

/** Apply a patch in place; returns the patch that restores the previous values. */
function patchObject(target: Record<string, unknown>, set: Record<string, unknown>, locked: string[]): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (locked.includes(k)) throw new OpError(`${k} can't be changed`);
    before[k] = k in target ? structuredClone(target[k]) : null;
    if (v === null || v === undefined) delete target[k];
    else target[k] = structuredClone(v);
  }
  return before;
}
