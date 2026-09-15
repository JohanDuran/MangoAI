export const secondsToFrames = (seconds: number, fps: number): number =>
  Math.round(seconds * fps);
