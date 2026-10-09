import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempData } from './helpers.ts';

const { root, cleanup } = useTempData();
const { createProject, addMarker, updateProjectSettings } = await import('../src/lib/scaffold.ts');
const { readMarkers, writeMarkers } = await import('../src/lib/markers.ts');
const { writeTranscript } = await import('../src/lib/transcript.ts');
const { narrationDir } = await import('../src/lib/narration.ts');
const { splitIntoCues, toSrt, captionCues, DEFAULT_CAPTIONS } = await import('../src/lib/captions.ts');
const { regenerateRegistry } = await import('../src/lib/registry.ts');
const { markerFrameRanges } = await import('../src/lib/ranges.ts');
const { bundleOverlay } = await import('../src/lib/overlayBundle.ts');

const project = createProject('Caption Test', { baseLayer: { type: 'transparent' }, fps: 30, width: 640, height: 360, durationInFrames: 900 });
const codeDir = path.join(root, 'projects', project.id, '03_remotion_code');

test('long text is split into short lines that share the time in order', () => {
  const text = 'If you start at twenty, compound interest does most of the work. Wait ten years and you need to save almost twice as much every month.';
  const cues = splitIntoCues(text, 2, 12);
  assert.ok(cues.length >= 3);
  assert.ok(cues.every((c) => c.text.length <= 42), JSON.stringify(cues));
  assert.equal(cues[0].start, 2);
  assert.equal(cues[cues.length - 1].end, 12);
  for (let i = 1; i < cues.length; i++) assert.equal(cues[i].start, cues[i - 1].end);
  assert.equal(cues.map((c) => c.text).join(' '), text);
  assert.ok(cues.some((c) => c.text.endsWith('work.')), 'a sentence end closes a line');
  assert.deepEqual(splitIntoCues('   ', 0, 1), []);
});

test('SRT numbering and timestamps', () => {
  const srt = toSrt([
    { start: 0, end: 1.5, text: 'One' },
    { start: 3661.25, end: 3662, text: 'Two' },
  ]);
  assert.equal(srt, '1\r\n00:00:00,000 --> 00:00:01,500\r\nOne\r\n\r\n2\r\n01:01:01,250 --> 01:01:02,000\r\nTwo\r\n');
});

test('captions come from the transcript, or from the voiceover when there is one', () => {
  writeTranscript(project.id, [{ start: 1, end: 3, text: 'Hello from the video.' }]);
  const on = { ...DEFAULT_CAPTIONS, mode: 'burn' as const };
  assert.deepEqual(captionCues(project.id, on), [{ start: 1, end: 3, text: 'Hello from the video.' }]);
  assert.deepEqual(captionCues(project.id, DEFAULT_CAPTIONS), [], 'nothing while captions are off');

  const m = addMarker(project.id, { start: 5, end: 9, prompt: 'p' });
  const file = `${m.marker_id}-aaaaaaaaaaaa.mp3`;
  fs.mkdirSync(narrationDir(project.id), { recursive: true });
  fs.writeFileSync(path.join(narrationDir(project.id), file), 'x');
  const markers = readMarkers(project.id);
  const target = markers.find((x) => x.marker_id === m.marker_id)!;
  target.narration = { text: 'Spoken line.', voice: 'marin', audio: { file, text: 'Spoken line.', voice: 'marin', durationSec: 2.5 } };
  writeMarkers(project.id, markers);

  assert.deepEqual(captionCues(project.id, on), [{ start: 5, end: 7.5, text: 'Spoken line.' }], 'auto prefers the voiceover');
  assert.deepEqual(captionCues(project.id, { ...on, source: 'transcript' }).map((c) => c.text), ['Hello from the video.']);

  // A line edited since its speech was made is not captioned with the old timing.
  target.narration = { ...target.narration, text: 'Changed.' };
  writeMarkers(project.id, markers);
  assert.deepEqual(captionCues(project.id, { ...on, source: 'voiceover' }), []);
  target.narration = { ...target.narration, text: 'Spoken line.' };
  writeMarkers(project.id, markers);
});

test('burned-in captions are wired into the overlay, compile, and are removed when turned off', async () => {
  updateProjectSettings(project.id, { captions: { ...DEFAULT_CAPTIONS, mode: 'burn' } });
  regenerateRegistry(project.id);
  assert.ok(fs.existsSync(path.join(codeDir, 'Captions.tsx')));
  assert.match(fs.readFileSync(path.join(codeDir, 'CustomOverlay.tsx'), 'utf-8'), /<Captions \/>/);
  const bundled = await bundleOverlay(project.id);
  assert.match(bundled.code, /Spoken line\./);

  // The MP4 export renders a caption's frames even where no marker is: the transcript caption at 1-3 s.
  updateProjectSettings(project.id, { captions: { ...DEFAULT_CAPTIONS, mode: 'burn', source: 'transcript' } });
  const ranges = markerFrameRanges(project.id, 0);
  assert.ok(ranges.some((r) => r.from <= 30 && r.to >= 90), JSON.stringify(ranges));

  updateProjectSettings(project.id, { captions: { ...DEFAULT_CAPTIONS, mode: 'srt' } });
  regenerateRegistry(project.id);
  assert.equal(fs.existsSync(path.join(codeDir, 'Captions.tsx')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(codeDir, 'CustomOverlay.tsx'), 'utf-8'), /Captions/);
  assert.equal(markerFrameRanges(project.id, 0).length, 1, 'only the marker when captions are not burned in');
});

test('voiceover captions switch when their first word is spoken, if the words match up', async () => {
  const { alignToWords } = await import('../src/lib/captions.ts');
  const cues = [
    { start: 10, end: 11, text: 'one two' },
    { start: 11, end: 12, text: 'three' },
  ];
  const words = [
    { text: 'One', start: 0.2, end: 0.5 },
    { text: 'two', start: 0.6, end: 0.9 },
    { text: 'three.', start: 1.6, end: 1.9 },
  ];
  assert.deepEqual(alignToWords(cues, words, 10, 12), [
    { start: 10.2, end: 11.6, text: 'one two' },
    { start: 11.6, end: 12, text: 'three' },
  ]);
  assert.deepEqual(alignToWords(cues, words.slice(0, 2), 10, 12), cues, 'a word count mismatch keeps the even pacing');
});

test('the generation prompt carries the word timings', async () => {
  const { buildRegeneratePrompt } = await import('../src/lib/claude.ts');
  const prompt = buildRegeneratePrompt({
    markerId: 'm1',
    currentCode: '',
    prompt: 'p',
    feedback: '',
    narration: 'Saving early wins.',
    narrationWords: [
      { text: 'Saving', start: 0, end: 0.4 },
      { text: 'early', start: 0.45, end: 0.8 },
      { text: 'wins.', start: 0.9, end: 1.3 },
    ],
    compositionWidth: 640,
    compositionHeight: 360,
    regionWidth: 640,
    regionHeight: 360,
    isFullScreen: true,
  });
  assert.match(prompt, /Saving 0\.00, early 0\.45, wins\. 0\.90/);
});

test.after(cleanup);
