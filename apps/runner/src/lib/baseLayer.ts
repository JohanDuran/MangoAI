// What a project's timeline is built on top of. 'video' is the original behavior (an uploaded
// raw_video file, see video.ts); the others let a project exist with no uploaded video at all.
export type BaseLayer =
  | { type: 'video' }
  | { type: 'color'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'transparent' };

export const DEFAULT_BASE_LAYER: BaseLayer = { type: 'video' };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isValidBaseLayer(v: unknown): v is BaseLayer {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  switch (b.type) {
    case 'video':
    case 'transparent':
      return true;
    case 'color':
      return typeof b.color === 'string' && HEX_COLOR.test(b.color);
    case 'gradient':
      return (
        typeof b.from === 'string' &&
        HEX_COLOR.test(b.from) &&
        typeof b.to === 'string' &&
        HEX_COLOR.test(b.to) &&
        typeof b.angle === 'number' &&
        Number.isFinite(b.angle)
      );
    default:
      return false;
  }
}
