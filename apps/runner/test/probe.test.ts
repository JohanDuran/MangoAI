import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { parseProbeOutput } = await import('../src/lib/probe.ts');

test('a landscape video keeps its size', () => {
  const info = parseProbeOutput({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio' }], format: { duration: '12.5' } });
  assert.deepEqual(info, { width: 1920, height: 1080, durationSeconds: 12.5, codec: 'h264', rotation: 0, hasAudio: true });
});

test('phone footage stored sideways is reported as displayed (rotation side data)', () => {
  const info = parseProbeOutput({ streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: '3' } });
  assert.equal(info?.width, 1080);
  assert.equal(info?.height, 1920);
  assert.equal(info?.rotation, 270);
});

test('older rotate tags are understood too', () => {
  const info = parseProbeOutput({ streams: [{ codec_type: 'video', width: 1280, height: 720, tags: { rotate: '90' } }], format: { duration: '1' } });
  assert.equal(info?.width, 720);
  assert.equal(info?.height, 1280);
});

test('files without a video stream are not videos', () => {
  assert.equal(parseProbeOutput({ streams: [{ codec_type: 'audio' }] }), null);
  assert.equal(parseProbeOutput({ streams: [] }), null);
  assert.equal(parseProbeOutput({}), null);
});

test.after(cleanup);
