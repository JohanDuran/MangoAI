import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFfmpeg, useTempData } from './helpers.ts';

const bins = findFfmpeg();
const { root, cleanup } = useTempData();

if (bins) {
  process.env.MANGO_FFMPEG = bins.ffmpeg;
  process.env.MANGO_FFPROBE = bins.ffprobe;
}
process.env.OPENAI_API_KEY = 'sk-test-key-not-real-000000000000';
process.env.MANGO_TRANSCRIBE_CHUNK_SECONDS = '20';

const { createProject } = await import('../src/lib/scaffold.ts');
const { transcribeProject, readTranscript } = await import('../src/lib/transcript.ts');

function makeVideo(target: string, seconds: number): void {
  const made = spawnSync(
    bins!.ffmpeg,
    ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-f', 'lavfi', '-i', `color=c=black:s=160x90:d=${seconds}`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', target],
    { windowsHide: true }
  );
  assert.equal(made.status, 0, made.stderr?.toString());
}

test('long audio is split, sent piece by piece, and timestamps are stitched together', { skip: bins ? false : 'ffmpeg not available (run "npm run runtime" first)' }, async () => {
  const project = createProject('Chunk Test', {});
  makeVideo(path.join(root, 'projects', project.id, '00_input', 'raw_video.mp4'), 50);

  const requests: number[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: FormData }) => {
    requests.push((init!.body!.get('file') as Blob).size);
    const n = requests.length;
    return new Response(JSON.stringify({ segments: [{ start: 0, end: 2, text: ` piece ${n} ` }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const segments = await transcribeProject(project.id);
    assert.ok(requests.length >= 2, `expected several requests, got ${requests.length}`);
    assert.equal(segments.length, requests.length);
    assert.equal(segments[0].start, 0);
    assert.equal(segments[0].text, 'piece 1');
    for (let i = 1; i < segments.length; i++) assert.ok(segments[i].start > segments[i - 1].start + 10, `${segments[i].start} vs ${segments[i - 1].start}`);
    assert.deepEqual(readTranscript(project.id), segments);
    assert.equal(fs.existsSync(path.join(root, 'projects', project.id, '01_transcript', 'audio.mp3')), false);
    assert.equal(fs.existsSync(path.join(root, 'projects', project.id, '01_transcript', 'chunks')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a rejected key stops at once with an actionable message', { skip: bins ? false : 'ffmpeg not available' }, async () => {
  const project = createProject('Key Test', {});
  makeVideo(path.join(root, 'projects', project.id, '00_input', 'raw_video.mp4'), 3);
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
  }) as typeof fetch;
  try {
    await assert.rejects(transcribeProject(project.id), /rejected your API key/);
    assert.equal(calls, 1, 'a bad key must not be retried');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.after(cleanup);
