import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFfmpeg, useTempData } from './helpers.ts';

const bins = findFfmpeg();
const { root, cleanup } = useTempData();
if (bins) {
  process.env.MANGO_FFMPEG = bins.ffmpeg;
  process.env.MANGO_FFPROBE = bins.ffprobe;
}
const { duckFactor, mergeIntervals, DUCK_LEVEL } = await import('../src/lib/music.ts');
const { writeMusicTrack } = await import('../src/routes/exportJob.ts');

test('the music is turned down under speech, with ramps either side', () => {
  const speech: [number, number][] = [[2, 4]];
  assert.equal(duckFactor(speech, 0), 1);
  assert.equal(duckFactor(speech, 3), DUCK_LEVEL);
  assert.ok(Math.abs(duckFactor(speech, 1.85) - (1 - (1 - DUCK_LEVEL) * 0.5)) < 1e-9, 'halfway down the ramp before speech');
  assert.equal(duckFactor(speech, 4.3), 1, 'back up a ramp after speech');
  assert.equal(duckFactor([], 3), 1);
});

test('speech close together is one stretch, and very many stretches are merged down', () => {
  assert.deepEqual(mergeIntervals([[0, 1], [1.5, 2], [5, 6]]), [[0, 2], [5, 6]]);
  const many = Array.from({ length: 400 }, (_, i) => [i * 2, i * 2 + 0.5] as [number, number]);
  assert.ok(mergeIntervals(many).length <= 150);
});

function meanVolume(file: string, from: number, to: number): number {
  const run = spawnSync(bins!.ffmpeg, ['-v', 'info', '-i', file, '-af', `atrim=${from}:${to},volumedetect`, '-f', 'null', '-'], { windowsHide: true });
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(run.stderr.toString())?.[1]);
}

test('the exported music track loops to the video length and is ducked where the preview ducks it', { skip: bins ? false : 'ffmpeg not available' }, async () => {
  const source = path.join(root, 'tune.mp3');
  const made = spawnSync(bins!.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-b:a', '128k', source], { windowsHide: true });
  assert.equal(made.status, 0);
  const out = path.join(root, 'music.wav');
  const settings = { file: 'music-00000000.mp3', name: 'tune.mp3', durationSec: 2, volume: 0.8, loop: true, duck: true };
  const result = await writeMusicTrack(source, settings, [[3, 5]], 8, out, new AbortController().signal);
  assert.equal(result.code, 0, result.log.slice(-800));

  const probe = spawnSync(bins!.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { windowsHide: true });
  assert.ok(Math.abs(Number(probe.stdout.toString()) - 8) < 0.1, 'looped to the full 8 s');

  const loud = meanVolume(out, 1, 2);
  const ducked = meanVolume(out, 3.5, 4.5);
  // DUCK_LEVEL 0.25 is about -12 dB.
  assert.ok(loud - ducked > 10 && loud - ducked < 14, `loud ${loud} dB, ducked ${ducked} dB`);
  assert.ok(Math.abs(meanVolume(out, 5.5, 6.3) - loud) < 1.5, 'back to full after the speech');
});

test.after(cleanup);
