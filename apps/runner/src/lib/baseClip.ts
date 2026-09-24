import { spawn } from 'node:child_process';
import type { BaseLayer } from './baseLayer.js';

export interface BaseClipGeometry {
  width: number;
  height: number;
  durationInFrames: number;
  fps: number;
}

// Angle convention matches the CSS `linear-gradient(<angle>deg, from, to)` used in the editor's
// preview, so exported color/gradient videos match what was shown while editing: 0deg points up,
// increasing clockwise. geq's Y axis points down, so the vertical component is negated.
function gradientExpr(channel: 'r' | 'g' | 'b', from: string, to: string, angle: number): string {
  const idx = { r: 1, g: 3, b: 5 }[channel];
  const f = parseInt(from.slice(idx, idx + 2), 16);
  const t = parseInt(to.slice(idx, idx + 2), 16);
  const rad = ((angle - 90) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const denom = Math.abs(dx) * 1 + Math.abs(dy) * 1 || 1;
  // t' = ((X/W - 0.5)*dx + (0.5 - Y/H)*dy) / denom + 0.5, clamped to [0,1]
  const tExpr = `(((X/W-0.5)*${dx.toFixed(6)}+(0.5-Y/H)*${dy.toFixed(6)})/${denom.toFixed(6)}+0.5)`;
  const clamped = `min(1,max(0,${tExpr}))`;
  return `(${f}+(${t}-${f})*${clamped})`;
}

// Renders a plain video file to stand in for an uploaded base video, so the rest of the export
// pipeline (ffprobe size, filter_complex overlay compositing) can treat it exactly like `raw`
// from findRawVideo without any special-casing.
export function synthesizeBaseClip(baseLayer: BaseLayer, geometry: BaseClipGeometry, outFile: string): Promise<{ ok: boolean; log: string }> {
  const { width, height, durationInFrames, fps } = geometry;
  const durationSec = durationInFrames / fps;
  const size = `${width}x${height}`;

  let args: string[];
  if (baseLayer.type === 'color') {
    args = ['-f', 'lavfi', '-i', `color=c=${baseLayer.color}:s=${size}:d=${durationSec}:r=${fps}`];
  } else if (baseLayer.type === 'gradient') {
    const r = gradientExpr('r', baseLayer.from, baseLayer.to, baseLayer.angle);
    const g = gradientExpr('g', baseLayer.from, baseLayer.to, baseLayer.angle);
    const b = gradientExpr('b', baseLayer.from, baseLayer.to, baseLayer.angle);
    args = [
      '-f', 'lavfi', '-i', `nullsrc=s=${size}:d=${durationSec}:r=${fps}`,
      '-vf', `geq=r='${r}':g='${g}':b='${b}'`,
    ];
  } else {
    return Promise.resolve({ ok: false, log: `synthesizeBaseClip called with unsupported baseLayer.type ${baseLayer.type}` });
  }

  return new Promise((resolve) => {
    let log = '';
    const child = spawn('ffmpeg', ['-y', ...args, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', outFile]);
    child.stderr.on('data', (c) => (log += c.toString()));
    child.on('error', (err) => resolve({ ok: false, log: `Could not run ffmpeg: ${err.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, log }));
  });
}
