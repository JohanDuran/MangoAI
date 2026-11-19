// Per-track interval index over resolved clips: "which clips overlap [a, b)?" in O(log n + hits),
// so drawing and playback stay cheap on a 2,000-clip timeline. Rebuilt when the editor version changes.
import type { Clip, Project, Resolved, Track } from '@mangoai/core';

export interface Span {
  id: string;
  clip: Clip;
  start: number;
  end: number;
  /** Position in its track (draw order within a track). */
  order: number;
}

export class TrackIndex {
  readonly spans: Span[];
  /** Overlapping clips are drawn in lanes, one below the other: each clip's lane, and how many there are. */
  readonly laneOf = new Map<string, number>();
  readonly lanes: number;
  private maxEnd: number[];

  constructor(track: Track, r: Resolved, fallbackEnd: number) {
    this.spans = [];
    track.clips.forEach((clip, order) => {
      const rc = r.clips.get(clip.id);
      if (!rc) return;
      const end = rc.end ?? fallbackEnd;
      this.spans.push({ id: clip.id, clip, start: rc.start, end, order });
    });
    this.spans.sort((a, b) => a.start - b.start || a.order - b.order);
    this.maxEnd = [];
    let m = -Infinity;
    for (const s of this.spans) this.maxEnd.push((m = Math.max(m, s.end)));
    const ends: number[] = [];
    for (const s of this.spans) {
      let lane = ends.findIndex((e) => e <= s.start + 1e-6);
      if (lane < 0) lane = ends.push(0) - 1;
      ends[lane] = s.end;
      this.laneOf.set(s.id, lane);
    }
    this.lanes = Math.max(1, ends.length);
  }

  /** Spans overlapping [a, b), in draw order. */
  query(a: number, b: number): Span[] {
    // last span with start < b
    let lo = 0;
    let hi = this.spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.spans[mid]!.start < b) lo = mid + 1;
      else hi = mid;
    }
    const out: Span[] = [];
    for (let i = lo - 1; i >= 0 && this.maxEnd[i]! > a; i--) {
      const s = this.spans[i]!;
      if (s.end > a) out.push(s);
    }
    return out.sort((x, y) => x.order - y.order);
  }

  at(t: number): Span[] {
    return this.query(t, t + 1e-6);
  }
}

export class TimelineIndex {
  readonly tracks = new Map<string, TrackIndex>();
  constructor(readonly project: Project, readonly resolved: Resolved) {
    for (const t of project.tracks) this.tracks.set(t.id, new TrackIndex(t, resolved, resolved.end));
  }
  get end() {
    return this.resolved.end;
  }
}
