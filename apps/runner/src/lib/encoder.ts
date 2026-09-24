import { spawnHidden } from './proc.js';
import { ffmpegBin } from './bin.js';

export interface VideoEncoder {
  // ffmpeg arguments selecting the encoder.
  args: string[];
  label: string;
  gpu: boolean;
}

const CPU: VideoEncoder = { args: ['-c:v', 'libx264'], label: 'CPU (libx264)', gpu: false };
const NVENC: VideoEncoder = {
  args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
  label: 'GPU (NVENC)',
  gpu: true,
};

// Uses the GPU encoder when a tiny test encode actually works (an encoder can be listed by
// ffmpeg without a usable GPU); MANGO_VIDEO_ENCODER=libx264 forces the CPU encoder. The answer
// cannot change while the app runs, so the probe happens once.
let probe: Promise<VideoEncoder> | null = null;
export function videoEncoder(): Promise<VideoEncoder> {
  probe ??= new Promise((resolve) => {
    if (process.env.MANGO_VIDEO_ENCODER === 'libx264') return resolve(CPU);
    const child = spawnHidden(ffmpegBin(), ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    child.on('error', () => resolve(CPU));
    child.on('close', (code) => resolve(code === 0 ? NVENC : CPU));
  });
  return probe;
}
