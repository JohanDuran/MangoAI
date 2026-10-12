import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFfmpeg, useTempData } from './helpers.ts';

const bins = findFfmpeg();
const { root, cleanup } = useTempData();
const needsFfmpeg = { skip: bins ? false : 'ffmpeg not available (run "npm run runtime" first)' };

if (bins) {
  process.env.MANGO_FFMPEG = bins.ffmpeg;
  process.env.MANGO_FFPROBE = bins.ffprobe;
}
process.env.OPENAI_API_KEY = 'sk-test-key-not-real-000000000000';

const { createProject, addMarker } = await import('../src/lib/scaffold.ts');
const { readMarkers, updateMarkerTiming } = await import('../src/lib/markers.ts');
const { setMarkerNarration, generateNarration, playableNarration, narrationFilePath, narrationDir, removeNarrationFiles, narrationClips } = await import(
  '../src/lib/narration.ts'
);
const { savePlanProposals, savePlanItems, readPlan } = await import('../src/lib/planStore.ts');
const { writeNarrationTrack } = await import('../src/routes/exportJob.ts');
const { readCompositionConfig } = await import('../src/lib/composition.ts');

// A short mp3, standing in for what OpenAI returns.
function makeSpeech(seconds: number): Buffer {
  const out = path.join(root, `speech-${seconds}.mp3`);
  const made = spawnSync(bins!.ffmpeg, ['-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-ac', '1', '-b:a', '64k', out], { windowsHide: true });
  assert.equal(made.status, 0, made.stderr?.toString());
  return fs.readFileSync(out);
}

function duration(file: string): number {
  const probe = spawnSync(bins!.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
  return Number.parseFloat(probe.stdout.toString().trim());
}

// Replaces fetch for the duration of `run`, recording the JSON bodies sent to OpenAI.
// Word-timing requests (Whisper) are answered with `words` and counted in `wordCalls`, not `calls`.
let wordCalls = 0;
let wordsResponse: () => Response = () =>
  new Response(JSON.stringify({ words: [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'there.', start: 0.45, end: 0.9 }] }), { status: 200 });

async function withFetch(respond: (n: number) => Response, run: (calls: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const calls: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      wordCalls++;
      return wordsResponse();
    }
    calls.push(JSON.parse(init?.body ?? '{}'));
    return respond(calls.length);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const project = createProject('Voice Test', { baseLayer: { type: 'color', color: '#000000' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });

test('a line is saved with its voice, and an empty line removes the voiceover', () => {
  const m = addMarker(project.id, { start: 0, end: 2, prompt: 'a' });
  setMarkerNarration(project.id, m.marker_id, { text: '  Hello there  ', voice: 'coral' });
  assert.deepEqual(readMarkers(project.id).find((x) => x.marker_id === m.marker_id)?.narration, { text: 'Hello there', voice: 'coral' });
  setMarkerNarration(project.id, m.marker_id, { text: '   ', voice: 'coral' });
  assert.equal(readMarkers(project.id).find((x) => x.marker_id === m.marker_id)?.narration, undefined);
});

test('unknown voices and overlong lines are refused', () => {
  const m = addMarker(project.id, { start: 2, end: 3, prompt: 'b' });
  assert.throws(() => setMarkerNarration(project.id, m.marker_id, { text: 'hi', voice: 'robot' }), /Unknown voice/);
  assert.throws(() => setMarkerNarration(project.id, m.marker_id, { text: 'x'.repeat(5000), voice: 'marin' }), /too long/);
});

test('speech is generated once, reused while the line is unchanged, and goes stale when it is edited', needsFfmpeg, async () => {
  const m = addMarker(project.id, { start: 3, end: 6, prompt: 'c' });
  setMarkerNarration(project.id, m.marker_id, { text: 'Compound interest does the heavy lifting.', voice: 'marin' });
  const speech = makeSpeech(1.5);
  await withFetch(
    () => new Response(speech, { status: 200 }),
    async (calls) => {
      const made = (await generateNarration(project.id, m.marker_id)).marker;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].voice, 'marin');
      assert.equal(calls[0].input, 'Compound interest does the heavy lifting.');
      const audio = made.narration?.audio;
      assert.ok(audio && Math.abs(audio.durationSec - 1.5) < 0.2, `duration ${audio?.durationSec}`);
      assert.ok(playableNarration(project.id, made));

      await generateNarration(project.id, m.marker_id);
      assert.equal(calls.length, 1, 'an unchanged line must not be paid for again');

      const edited = setMarkerNarration(project.id, m.marker_id, { text: 'Compound interest wins.', voice: 'marin' });
      assert.equal(playableNarration(project.id, edited), null, 'an edited line must not play the old words');
      assert.ok(edited.narration?.audio, 'the old take is kept until a new one replaces it');

      const again = (await generateNarration(project.id, m.marker_id)).marker;
      assert.equal(calls.length, 2);
      assert.ok(playableNarration(project.id, again));
      const files = fs.readdirSync(narrationDir(project.id)).filter((f) => f.startsWith(`${m.marker_id}-`));
      assert.deepEqual(files, [again.narration!.audio!.file], 'the replaced take is deleted');
    }
  );
});

test('a voice longer than its marker lengthens it and moves every later marker back by as much, never past the end of the video', needsFfmpeg, async () => {
  const room = createProject('Voice Room', { baseLayer: { type: 'video' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });
  const a = addMarker(room.id, { start: 0, end: 2, prompt: 'a' });
  const b = addMarker(room.id, { start: 2.5, end: 4, prompt: 'b' });
  const c = addMarker(room.id, { start: 6, end: 8, prompt: 'c' });
  const timing = () => readMarkers(room.id).map((m) => [m.start, m.end]);
  setMarkerNarration(room.id, a.marker_id, { text: 'Longer than its marker.', voice: 'marin' });
  setMarkerNarration(room.id, c.marker_id, { text: 'Far too long for what is left.', voice: 'marin' });
  await withFetch(
    (n) => new Response(makeSpeech(n === 1 ? 3 : 9), { status: 200 }),
    async (calls) => {
      const made = await generateNarration(room.id, a.marker_id);
      assert.ok(made.retimed);
      const voice = made.marker.narration!.audio!.durationSec;
      assert.ok(Math.abs(voice - 3) < 0.2, `voice ${voice}s`);
      assert.ok(Math.abs(duration(narrationFilePath(room.id, made.marker.narration!.audio!.file)!) - voice) < 0.05, 'the voice is not sped up or cut');
      const [ta, tb, tc] = timing();
      assert.ok(ta[1] >= voice && ta[1] < voice + 0.5, `marker a ends at ${ta[1]}`);
      const growth = ta[1] - 2;
      const near = (x: number, y: number) => Math.abs(x - y) < 0.011;
      assert.ok(near(tb[0], 2.5 + growth) && near(tb[1], 4 + growth), `marker b moved to ${tb}`);
      assert.ok(near(tc[0], 6 + growth) && near(tc[1], 8 + growth), `marker c moved to ${tc}: every later marker moves by the same amount`);

      // No room before the end of the video: nothing changes and no take is recorded.
      const before = timing();
      await assert.rejects(generateNarration(room.id, c.marker_id), /past the end of the video/);
      assert.deepEqual(timing(), before);
      assert.equal(readMarkers(room.id).find((m) => m.marker_id === c.marker_id)?.narration?.audio, undefined);
      await assert.rejects(generateNarration(room.id, c.marker_id), /past the end of the video/);
      assert.equal(calls.length, 2, 'the take is kept, so trying again is not paid for');
    }
  );
});

test('on a blank canvas a voice that runs past the end makes the canvas longer', needsFfmpeg, async () => {
  const canvas = createProject('Voice Canvas', { baseLayer: { type: 'color', color: '#000000' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });
  const a = addMarker(canvas.id, { start: 8, end: 9, prompt: 'a' });
  setMarkerNarration(canvas.id, a.marker_id, { text: 'Longer than what is left.', voice: 'marin' });
  await withFetch(
    () => new Response(makeSpeech(4), { status: 200 }),
    async () => {
      const made = await generateNarration(canvas.id, a.marker_id);
      assert.ok(made.marker.end > 12, `ends at ${made.marker.end}`);
      assert.equal(readCompositionConfig(canvas.id).durationInFrames, Math.ceil(made.marker.end * 30 - 0.001));
    }
  );
});

test('a rejected key and an empty account fail at once with an actionable message', async () => {
  const m = addMarker(project.id, { start: 6, end: 7, prompt: 'd' });
  setMarkerNarration(project.id, m.marker_id, { text: 'Hi.', voice: 'marin' });
  await withFetch(
    () => new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 }),
    async (calls) => {
      await assert.rejects(generateNarration(project.id, m.marker_id), /rejected your API key/);
      assert.equal(calls.length, 1);
    }
  );
  await withFetch(
    () => new Response('{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}', { status: 429 }),
    async (calls) => {
      await assert.rejects(generateNarration(project.id, m.marker_id), /out of credit/);
      assert.equal(calls.length, 1);
    }
  );
  assert.equal(readMarkers(project.id).find((x) => x.marker_id === m.marker_id)?.narration?.audio, undefined);
});

test('a server error is retried', needsFfmpeg, async () => {
  const m = addMarker(project.id, { start: 7, end: 8, prompt: 'e' });
  setMarkerNarration(project.id, m.marker_id, { text: 'Second try.', voice: 'marin' });
  const speech = makeSpeech(0.5);
  await withFetch(
    (n) => (n === 1 ? new Response('upstream failed', { status: 503 }) : new Response(speech, { status: 200 })),
    async (calls) => {
      const made = (await generateNarration(project.id, m.marker_id)).marker;
      assert.equal(calls.length, 2);
      assert.ok(playableNarration(project.id, made));
    }
  );
});

test('missing key is reported without calling OpenAI', async () => {
  const m = addMarker(project.id, { start: 8, end: 9, prompt: 'f' });
  setMarkerNarration(project.id, m.marker_id, { text: 'No key.', voice: 'marin' });
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(generateNarration(project.id, m.marker_id), /No OpenAI API key/);
  } finally {
    process.env.OPENAI_API_KEY = key;
  }
});

test('narration files are only served by their exact name', () => {
  assert.equal(narrationFilePath(project.id, '../project.json'), null);
  assert.equal(narrationFilePath(project.id, 'm1-0123456789ab.mp3.tmp'), null);
  assert.equal(narrationFilePath(project.id, 'm99-0123456789ab.mp3'), null, 'a name that matches but does not exist');
});

test("a marker's files are removed with it, other markers' are kept", () => {
  const dir = narrationDir(project.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['m40-aaaaaaaaaaaa.mp3', 'm40-bbbbbbbbbbbb.mp3', 'm400-cccccccccccc.mp3']) fs.writeFileSync(path.join(dir, f), 'x');
  removeNarrationFiles(project.id, 'm40');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('m40')), ['m400-cccccccccccc.mp3']);
});

test('the export voiceover track lines each clip up with its marker and lasts the whole video', needsFfmpeg, async () => {
  const clips = narrationClips(project.id);
  assert.ok(clips.length >= 2, `expected generated clips, got ${clips.length}`);
  // Moving a marker moves its voice with it.
  const moved = clips[0];
  updateMarkerTiming(project.id, moved.markerId, { start: moved.start + 0.5, end: moved.end + 0.5 });
  assert.equal(narrationClips(project.id).find((c) => c.markerId === moved.markerId)?.start, moved.start + 0.5);

  const out = path.join(root, 'narration.wav');
  const made = await writeNarrationTrack(narrationClips(project.id), 10, 0.8, out, new AbortController().signal);
  assert.equal(made.code, 0, made.log.slice(-800));
  assert.ok(Math.abs(duration(out) - 10) < 0.1, `track is ${duration(out)}s`);

  // A clip starting near the end is cut at the end of the video instead of making the track longer.
  const late = [{ ...narrationClips(project.id)[0], start: 9.5 }];
  const lateOut = path.join(root, 'narration-late.wav');
  assert.equal((await writeNarrationTrack(late, 10, 1, lateOut, new AbortController().signal)).code, 0);
  assert.ok(Math.abs(duration(lateOut) - 10) < 0.1, `track is ${duration(lateOut)}s`);
});

test('plan items keep their voiceover lines through review edits', () => {
  savePlanProposals(project.id, { kind: 'idea', idea: 'x', narration: true }, {
    proposals: [
      { start: 10, end: 12, prompt: 'p', region: null, assets: [], narration: 'First line.', generateImage: false },
      { start: 12, end: 14, prompt: 'q', region: null, assets: [], narration: '', generateImage: false },
    ],
    droppedCount: 0,
    movedCount: 0,
    look: '',
  });
  const plan = readPlan(project.id)!;
  assert.equal(plan.items[0].narration, 'First line.');
  assert.equal(plan.items[1].narration, undefined);
  savePlanItems(project.id, plan.items.map((i) => ({ ...i, narration: 'Edited.' })));
  assert.deepEqual(readPlan(project.id)!.items.map((i) => i.narration), ['Edited.', 'Edited.']);
  assert.throws(() => savePlanItems(project.id, [{ ...plan.items[0], narration: 5 }]), /plan items/);
});

test('word timings are read once per take, and a failed reading does not cost the voice', needsFfmpeg, async () => {
  const m = addMarker(project.id, { start: 20, end: 25, prompt: 'w' });
  setMarkerNarration(project.id, m.marker_id, { text: 'Hello there.', voice: 'marin' });
  const speech = makeSpeech(1);
  const before = wordCalls;
  await withFetch(
    () => new Response(speech, { status: 200 }),
    async () => {
      const { marker } = await generateNarration(project.id, m.marker_id);
      assert.deepEqual(marker.narration?.audio?.words, [
        { text: 'Hello', start: 0.1, end: 0.4 },
        { text: 'there.', start: 0.45, end: 0.9 },
      ]);
      await generateNarration(project.id, m.marker_id);
      assert.equal(wordCalls - before, 1, 'an unchanged take is not read again');
    }
  );

  setMarkerNarration(project.id, m.marker_id, { text: 'Hello again.', voice: 'marin' });
  const saved = wordsResponse;
  wordsResponse = () => new Response('{"error":{"message":"boom"}}', { status: 500 });
  try {
    await withFetch(
      () => new Response(speech, { status: 200 }),
      async () => {
        const { marker } = await generateNarration(project.id, m.marker_id);
        assert.ok(playableNarration(project.id, marker), 'the voice is kept');
        assert.equal(marker.narration?.audio?.words, undefined);
      }
    );
  } finally {
    wordsResponse = saved;
  }
});

test.after(cleanup);
