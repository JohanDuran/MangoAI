import { runCommand } from './proc.js';
import { ffprobeBin } from './bin.js';

export interface VideoInfo {
  // Size as displayed, i.e. after applying rotation metadata (phone footage is stored sideways).
  width: number;
  height: number;
  durationSeconds: number;
  codec: string;
  rotation: number;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

// Reads what ffprobe knows about a media file. Returns null when it is not a readable video.
export async function probeVideo(file: string): Promise<VideoInfo | null> {
  const result = await runCommand(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  let data: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const video = data.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
  if (!video) return null;
  const rotationRaw = video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(video.tags?.rotate ?? 0);
  const rotation = ((Math.round(rotationRaw / 90) * 90) % 360 + 360) % 360;
  const sideways = rotation === 90 || rotation === 270;
  const duration = Number.parseFloat(data.format?.duration ?? video.duration ?? '0');
  return {
    width: sideways ? video.height! : video.width!,
    height: sideways ? video.width! : video.height!,
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    codec: video.codec_name ?? 'unknown',
    rotation,
    hasAudio: data.streams?.some((s) => s.codec_type === 'audio') ?? false,
  };
}

// Codecs that a Chromium-based preview may not decode everywhere; export still works.
export const PREVIEW_RISKY_CODECS = new Set(['hevc', 'h265', 'prores', 'mpeg2video', 'wmv3', 'vc1', 'dnxhd']);
