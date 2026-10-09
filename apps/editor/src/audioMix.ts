// The background music's ducking curve, mirroring the runner's music.ts (duckFactor), which the
// export turns into an ffmpeg expression: keep them in step so the preview sounds like the export.

export function duckFactor(intervals: [number, number][], t: number, duckLevel: number, rampSec: number): number {
  let presence = 0;
  for (const [a, b] of intervals) {
    const rise = Math.min(1, Math.max(0, (t - a + rampSec) / rampSec));
    const fall = Math.min(1, Math.max(0, (b + rampSec - t) / rampSec));
    presence = Math.max(presence, Math.min(rise, fall));
  }
  return 1 - (1 - duckLevel) * presence;
}
