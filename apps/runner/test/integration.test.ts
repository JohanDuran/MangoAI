import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { findFfmpeg, useTempData } from './helpers.ts';

// The failure drills: the real server, started as a child process, talking to a stand-in for the Claude
// CLI that can be told to fail, hang or be signed out. Windows only, because the stand-in is a .cmd shim
// (which is also how npm installs the real CLI, so the shim path is worth exercising).
const runnable = process.platform === 'win32';
const bins = findFfmpeg();
const { root, cleanup } = useTempData();
const serverDir = path.resolve(import.meta.dirname, '..');

const fake = path.join(root, 'fake bin', 'claude.cmd');
fs.mkdirSync(path.dirname(fake), { recursive: true });
fs.writeFileSync(
  fake,
  [
    '@echo off',
    'setlocal',
    'set MODE=ok',
    'if exist "%~dp0mode.txt" set /p MODE=<"%~dp0mode.txt"',
    'if "%MODE%"=="signedout" goto signedout',
    'if "%MODE%"=="hang" goto hang',
    'if "%MODE%"=="version" goto version',
    'if "%MODE%"=="plan" goto plan',
    'if "%MODE%"=="planimage" goto planimage',
    'if "%MODE%"=="slow" goto slow',
    ':ok',
    'echo {"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01}',
    'exit /b 0',
    ':slow',
    'ping -n 4 127.0.0.1 >nul',
    'echo {"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01}',
    'exit /b 0',
    ':signedout',
    'echo {"type":"result","subtype":"success","is_error":true,"result":"Invalid API key - Please run /login"}',
    'exit /b 1',
    ':hang',
    'ping -n 40 127.0.0.1 >nul',
    'exit /b 0',
    ':version',
    'echo 2.1.0 (Claude Code)',
    'exit /b 0',
    ':planimage',
    'echo {"type":"result","subtype":"success","is_error":false,"result":"[{\\"start\\":0.5,\\"end\\":2,\\"prompt\\":\\"A photo of a beach\\",\\"region\\":null,\\"generateImage\\":true},{\\"start\\":3,\\"end\\":5,\\"prompt\\":\\"Big number\\",\\"region\\":null,\\"generateImage\\":false}]","total_cost_usd":0.01}',
    'exit /b 0',
    ':plan',
    'echo {"type":"result","subtype":"success","is_error":false,"result":"[{\\"start\\":0.5,\\"end\\":2,\\"prompt\\":\\"Title card\\",\\"region\\":null},{\\"start\\":3,\\"end\\":5,\\"prompt\\":\\"Big number\\",\\"region\\":null}]","total_cost_usd":0.01}',
    'exit /b 0',
  ].join('\r\n')
);
const setMode = (mode: string) => fs.writeFileSync(path.join(path.dirname(fake), 'mode.txt'), mode);

let server: ChildProcess | null = null;
let base = '';

async function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  const env = {
    ...process.env,
    PORT: '0',
    MANGO_PROJECTS_DIR: process.env.MANGO_PROJECTS_DIR!,
    MANGO_LOG_DIR: process.env.MANGO_LOG_DIR!,
    MANGO_CLAUDE_PATH: fake,
    MANGO_SKIP_RENDER_CHECK: '1',
    // Never reach the real OpenAI (the runner's .env may hold a real key): requests fail at once.
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    ...(bins ? { MANGO_FFMPEG: bins.ffmpeg, MANGO_FFPROBE: bins.ffprobe } : {}),
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: serverDir, env, windowsHide: true });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30_000);
    const onData = (chunk: Buffer) => {
      const match = /url=(http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    server!.stdout!.on('data', onData);
    server!.stderr!.on('data', (c) => process.stderr.write(c));
  });
}

async function stopServer(): Promise<void> {
  const child = server;
  if (!child) return;
  server = null;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    setTimeout(resolve, 3000);
  });
}

const api = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);
const json = { 'Content-Type': 'application/json' };

async function sse(p: string, body: unknown, opts: { abortAfterMs?: number } = {}): Promise<{ events: { event: string; data: any }[]; aborted: boolean }> {
  const controller = new AbortController();
  if (opts.abortAfterMs) setTimeout(() => controller.abort(), opts.abortAfterMs);
  let text = '';
  let aborted = false;
  try {
    const res = await api(p, { method: 'POST', headers: json, body: JSON.stringify(body), signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch {
    aborted = true;
  }
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /event: (.*)/.exec(block)?.[1] ?? '', data: JSON.parse(/data: (.*)/.exec(block)?.[1] ?? 'null') }));
  return { events, aborted };
}

const logText = () => {
  try {
    return fs.readFileSync(path.join(process.env.MANGO_LOG_DIR!, 'runner.log'), 'utf-8');
  } catch {
    return '';
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newProject(baseLayer: unknown = { type: 'transparent' }): Promise<string> {
  const res = await api('/projects', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Drill', baseLayer, width: 640, height: 360, durationInFrames: 300 }) });
  return ((await res.json()) as { id: string }).id;
}

const skip = runnable ? false : 'Windows only';

test('the server only answers requests meant for it', { skip }, async () => {
  await startServer();
  assert.equal((await api('/health')).status, 200);
  // fetch() ignores a custom Host header, so DNS-rebinding style requests are sent raw
  const status = await new Promise<number>((resolve) => {
    const req = http.request(`${base}/health`, { headers: { Host: 'evil.example.com', Connection: 'close' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(status, 403);
  const foreign = await api('/projects', { method: 'POST', headers: { ...json, Origin: 'https://evil.example.com' }, body: JSON.stringify({ name: 'x' }) });
  assert.equal(foreign.status, 403, 'writes from other websites');
  const traversal = await api('/projects/..%2F..%2Fsecret/overlay.js');
  assert.equal(traversal.status, 400);
  const traversalAsset = await api('/projects/x/assets/..%2F..%2Fproject.json');
  assert.ok([400, 404, 500].includes(traversalAsset.status));
});

test('a signed-out CLI fails once with a clear message and does not burn three attempts', { skip }, async () => {
  setMode('signedout');
  const id = await newProject();
  await api(`/projects/${id}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 2, prompt: 'hello' }) });
  const before = fs.readFileSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '03_remotion_code', 'marker_m1.tsx'), 'utf-8');
  const { events } = await sse(`/projects/${id}/markers/m1/regenerate`, { feedback: 'more red' });
  const done = events.find((e) => e.event === 'done')!;
  assert.equal(done.data.success, false);
  assert.match(done.data.error, /not signed in/i);
  assert.equal(events.filter((e) => e.event === 'progress' && e.data.phase === 'invoking-claude').length, 1, 'no retries');
  assert.equal(fs.readFileSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '03_remotion_code', 'marker_m1.tsx'), 'utf-8'), before, 'the marker code is untouched');
});

test('closing the browser mid-run stops Claude', { skip }, async () => {
  setMode('hang');
  const id = await newProject();
  await api(`/projects/${id}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 2, prompt: 'hello' }) });
  const started = Date.now();
  await sse(`/projects/${id}/markers/m1/regenerate`, { feedback: 'x' }, { abortAfterMs: 2000 });
  for (let i = 0; i < 40 && !/claude\.exit.*failure=cancelled/.test(logText()); i++) await sleep(250);
  assert.match(logText(), /claude\.exit.*failure=cancelled/, 'the run is ended when the client disconnects');
  assert.ok(Date.now() - started < 15_000, 'it must not wait for the hung process');
  // the marker keeps the status it had before the cancelled run
  const marker = ((await (await api(`/projects/${id}`)).json()) as { markers: { status: string }[] }).markers[0];
  assert.equal(marker.status, 'draft');
});

const markerCode = (id: string, markerId: string) =>
  fs.readFileSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '03_remotion_code', `marker_${markerId}.tsx`), 'utf-8');
const getPlan = async (id: string) => (await (await api(`/projects/${id}/plan`)).json()) as { plan: any; running: string[] };
const stop = (id: string, tag?: string) => api(`/projects/${id}/stop`, { method: 'POST', headers: json, body: JSON.stringify({ tag }) });

test('Stop ends a regenerate at once and puts the marker back as it was', { skip }, async () => {
  setMode('hang');
  const id = await newProject();
  await api(`/projects/${id}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 2, prompt: 'hello' }) });
  const before = markerCode(id, 'm1');
  const started = Date.now();
  const run = sse(`/projects/${id}/markers/m1/regenerate`, { feedback: 'x' });
  await sleep(1500);
  assert.equal(((await (await stop(id, 'regenerate:m1')).json()) as { stopped: number }).stopped, 1);
  const { events } = await run;
  const done = events.find((e) => e.event === 'done')!;
  assert.equal(done.data.cancelled, true);
  assert.ok(Date.now() - started < 15_000, 'it must not wait for the hung process');
  assert.equal(markerCode(id, 'm1'), before);
  assert.deepEqual((await getPlan(id)).running, []);
});

test('a plan is saved as soon as it exists, keeps review edits, and is removed once applied', { skip }, async () => {
  setMode('plan');
  const id = await newProject();
  const planned = (await (await api(`/projects/${id}/markers/plan-from-idea`, { method: 'POST', headers: json, body: JSON.stringify({ idea: 'two beats' }) })).json()) as any;
  assert.equal(planned.plan.items.length, 2);

  const saved = await getPlan(id);
  assert.equal(saved.plan.state, 'review');
  assert.deepEqual(saved.plan.source, { kind: 'idea', idea: 'two beats' });

  const region = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  const edited = saved.plan.items.map((i: any) => ({ ...i, region }));
  assert.equal((await api(`/projects/${id}/plan`, { method: 'PUT', headers: json, body: JSON.stringify({ items: edited }) })).status, 200);
  assert.deepEqual((await getPlan(id)).plan.items.map((i: any) => i.region), [region, region]);

  setMode('ok');
  const { events } = await sse(`/projects/${id}/markers/apply`, { markers: edited });
  const done = events.find((e) => e.event === 'done')!;
  assert.equal(done.data.planRemaining, false, JSON.stringify(events));
  assert.equal((await getPlan(id)).plan, null);
});

test('an idea plan ticks AI image generation where Claude asks for it, only when allowed', { skip }, async () => {
  setMode('planimage');
  const id = await newProject();
  const plan = (body: unknown) =>
    api(`/projects/${id}/markers/plan-from-idea`, { method: 'POST', headers: json, body: JSON.stringify(body) }).then(async (r) => ((await r.json()) as any).plan);

  const allowed = await plan({ idea: 'beach trip', images: true });
  assert.deepEqual(allowed.items.map((i: any) => i.allowImage), [true, false]);
  assert.equal(allowed.source.images, true);

  const notAllowed = await plan({ idea: 'beach trip' });
  assert.deepEqual(notAllowed.items.map((i: any) => i.allowImage), [false, false]);
  assert.equal(notAllowed.source.images, undefined);
});

test('the idea chat keeps the conversation and brief, and a stopped reply leaves it as it was', { skip }, async () => {
  setMode('ok');
  const id = await newProject();
  const chatOf = async (res: Response) => ((await res.json()) as any).chat;
  const send = (text: string) => api(`/projects/${id}/idea-chat/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text, narration: true }) });

  const first = await chatOf(await send('a video about compound interest'));
  assert.deepEqual(first.messages.map((m: any) => [m.role, m.text]), [['user', 'a video about compound interest'], ['assistant', 'done']]);
  assert.equal(first.brief, null);

  const briefed = await chatOf(await api(`/projects/${id}/idea-chat/brief`, { method: 'POST', headers: json, body: '{}' }));
  assert.equal(briefed.brief, 'done');
  await api(`/projects/${id}/idea-chat/brief`, { method: 'PUT', headers: json, body: JSON.stringify({ brief: 'my own brief' }) });

  setMode('hang');
  const pending = send('one more thing');
  await sleep(1500);
  assert.equal((await send('meanwhile')).status, 409, 'one turn at a time');
  assert.equal(((await (await stop(id, 'chat')).json()) as { stopped: number }).stopped, 1);
  assert.equal((await pending).status, 499);

  const saved = await chatOf(await api(`/projects/${id}/idea-chat`));
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.brief, 'my own brief');

  assert.equal((await api(`/projects/${id}/idea-chat`, { method: 'DELETE' })).status, 204);
  const cleared = await chatOf(await api(`/projects/${id}/idea-chat`));
  assert.deepEqual([cleared.messages, cleared.brief], [[], null]);
});

test('applying a plan keeps markers past the end and overlapping ones, and the timeline grows', { skip }, async () => {
  setMode('ok');
  const id = await newProject();
  const markers = [
    { start: 1, end: 4, prompt: 'scene', region: null, allowSkills: [] },
    { start: 2, end: 3, prompt: 'caption over the scene', region: null, allowSkills: [] },
    { start: 9, end: 12.5, prompt: 'runs past the 10s end', region: null, allowSkills: [] },
  ];
  const { events } = await sse(`/projects/${id}/markers/apply`, { markers, look: 'navy and mango' });
  assert.equal(events.find((e) => e.event === 'done')!.data.completed, 3, JSON.stringify(events));
  const project = (await (await api(`/projects/${id}`)).json()) as any;
  assert.deepEqual(project.markers.map((m: any) => [m.start, m.end, m.look]), [
    [1, 4, 'navy and mango'],
    [2, 3, 'navy and mango'],
    [9, 12.5, 'navy and mango'],
  ]);
  assert.equal(project.composition.durationInFrames, 375);
});

test('Stop during apply removes the half-made marker and keeps the rest of the plan', { skip }, async () => {
  setMode('plan');
  const id = await newProject();
  const { plan } = (await (await api(`/projects/${id}/markers/plan-from-idea`, { method: 'POST', headers: json, body: JSON.stringify({ idea: 'two beats' }) })).json()) as any;
  setMode('hang');
  const run = sse(`/projects/${id}/markers/apply`, { markers: plan.items });
  for (let i = 0; i < 40 && (await getPlan(id)).plan.items[0].markerId === undefined; i++) await sleep(250);
  assert.equal((await getPlan(id)).plan.state, 'applying');
  await sleep(1000);
  await stop(id, 'apply');
  const { events } = await run;
  assert.ok(events.some((e) => e.event === 'item-done' && e.data.cancelled && e.data.removed));
  assert.equal(events.find((e) => e.event === 'done')!.data.planRemaining, true);
  const after = await getPlan(id);
  assert.equal(after.plan.state, 'review');
  assert.ok(after.plan.items.every((i: any) => i.markerId === undefined));
  const project = (await (await api(`/projects/${id}`)).json()) as { markers: unknown[] };
  assert.equal(project.markers.length, 0, 'the unfinished marker is gone');
});

test("a plan's voice is kept with it and reads its lines; otherwise the project's voice does", { skip }, async () => {
  setMode('plan');
  const id = await newProject();
  await api(`/projects/${id}/voice`, { method: 'PUT', headers: json, body: JSON.stringify({ voice: 'coral' }) });
  const planned = (await (
    await api(`/projects/${id}/markers/plan-from-idea`, { method: 'POST', headers: json, body: JSON.stringify({ idea: 'two beats', narration: true, voice: 'onyx' }) })
  ).json()) as any;
  assert.equal(planned.plan.source.voice, 'onyx');
  assert.equal((await getPlan(id)).plan.source.voice, 'onyx', 'kept with the saved plan');

  setMode('ok');
  const markers = [
    { start: 0, end: 1.5, prompt: 'a', region: null, narration: 'First line.', voice: 'onyx' },
    { start: 3, end: 4.5, prompt: 'b', region: null, narration: 'Second line.' },
  ];
  const { events } = await sse(`/projects/${id}/markers/apply`, { markers });
  // Speech cannot be made here (no OpenAI), which is reported per marker without stopping the apply.
  assert.equal(events.filter((e) => e.event === 'item-voice').length, 2, JSON.stringify(events));
  const project = (await (await api(`/projects/${id}`)).json()) as { markers: { narration?: { voice: string } }[]; project: { voice?: string } };
  assert.deepEqual(project.markers.map((m) => m.narration?.voice), ['onyx', 'coral']);
  assert.equal(project.project.voice, 'coral', "a plan's voice does not change the project's");
});

test('applying a plan generates several markers at once', { skip }, async () => {
  setMode('slow');
  const id = await newProject();
  const markers = [0, 2, 4].map((start) => ({ start, end: start + 1.5, prompt: `beat at ${start}`, region: null }));
  const began = Date.now();
  const { events } = await sse(`/projects/${id}/markers/apply`, { markers });
  const seconds = (Date.now() - began) / 1000;
  const done = events.filter((e) => e.event === 'item-done');
  assert.equal(done.length, 3, JSON.stringify(events));
  assert.ok(done.every((e) => e.data.success), JSON.stringify(done));
  // Each stand-in run takes about 3 s: one after another would be at least 9 s.
  assert.ok(seconds < 7.5, `took ${seconds.toFixed(1)} s`);
  setMode('ok');
});

test('Stop during a parallel apply removes every unfinished marker', { skip }, async () => {
  setMode('hang');
  const id = await newProject();
  const markers = [0, 2, 4, 6].map((start) => ({ start, end: start + 1.5, prompt: `beat at ${start}`, region: null }));
  const run = sse(`/projects/${id}/markers/apply`, { markers });
  await sleep(2500);
  await stop(id, 'apply');
  const { events } = await run;
  assert.equal(events.filter((e) => e.event === 'item-done' && e.data.cancelled && e.data.removed).length, 4, JSON.stringify(events));
  const project = (await (await api(`/projects/${id}`)).json()) as { markers: unknown[] };
  assert.equal(project.markers.length, 0);
  setMode('ok');
});

test('planning cut off by the editor going away is kept so it can be retried', { skip }, async () => {
  setMode('hang');
  const id = await newProject();
  await sse(`/projects/${id}/markers/plan-from-idea`, { idea: 'resume me' }, { abortAfterMs: 1500 });
  for (let i = 0; i < 40 && (await getPlan(id)).running.length > 0; i++) await sleep(250);
  const { plan, running } = await getPlan(id);
  assert.deepEqual(running, []);
  assert.equal(plan.state, 'planning');
  assert.deepEqual(plan.source, { kind: 'idea', idea: 'resume me' });
  assert.equal((await api(`/projects/${id}/plan`, { method: 'DELETE' })).status, 204);
  assert.equal((await getPlan(id)).plan, null);
});

test('a hung Claude run is stopped by the timeout and reported', { skip }, async () => {
  await stopServer();
  await startServer({ MANGO_CLAUDE_TIMEOUT_MS: '1500' });
  setMode('hang');
  const id = await newProject();
  await api(`/projects/${id}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 2, prompt: 'hello' }) });
  const started = Date.now();
  const { events } = await sse(`/projects/${id}/markers/m1/regenerate`, { feedback: 'x' });
  const done = events.find((e) => e.event === 'done')!;
  assert.equal(done.data.success, false);
  assert.match(done.data.error, /took too long/);
  assert.ok(Date.now() - started < 30_000);
});

test('a video project refuses markers, plans and generation until its video is uploaded', { skip: runnable && bins ? false : 'needs Windows and the staged ffmpeg' }, async () => {
  const id = await newProject({ type: 'video' });
  const refused = async (p: string, body: unknown) => {
    const res = await api(p, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(res.status, 409, p);
    assert.match(((await res.json()) as { error: string }).error, /Upload the video first/);
  };
  await refused(`/projects/${id}/markers`, { start: 0, end: 1, prompt: 'x' });
  await refused(`/projects/${id}/markers/plan-from-idea`, { idea: 'x' });
  await refused(`/projects/${id}/markers/plan`, {});
  await refused(`/projects/${id}/markers/apply`, { markers: [] });
  await refused(`/projects/${id}/markers/m1/regenerate`, {});

  const clip = path.join(root, 'gate.mp4');
  const made = spawnSync(bins!.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { windowsHide: true });
  assert.equal(made.status, 0);
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(clip)], { type: 'video/mp4' }), 'clip.mp4');
  assert.equal((await api(`/projects/${id}/video`, { method: 'POST', body: form })).status, 201);
  const added = await api(`/projects/${id}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 1, prompt: 'x' }) });
  assert.equal(added.status, 201);

  // Projects with no video at all are not affected.
  const colored = await newProject({ type: 'color', color: '#000000' });
  assert.equal((await api(`/projects/${colored}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 1, prompt: 'x' }) })).status, 201);
});

test('a bad upload is refused and never replaces the current video', { skip: runnable && bins ? false : 'needs Windows and the staged ffmpeg' }, async () => {
  const id = await newProject({ type: 'video' });
  const good = path.join(root, 'good.mp4');
  const made = spawnSync(bins!.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', good], { windowsHide: true });
  assert.equal(made.status, 0);

  const upload = (file: string, name: string, type: string) => {
    const form = new FormData();
    form.append('video', new Blob([fs.readFileSync(file)], { type }), name);
    return api(`/projects/${id}/video`, { method: 'POST', body: form });
  };
  const ok = await upload(good, 'clip.mp4', 'video/mp4');
  assert.equal(ok.status, 201);
  const info = (await ok.json()) as { info: { width: number; height: number } };
  assert.deepEqual([info.info.width, info.info.height], [320, 180]);
  const goodSize = fs.statSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '00_input', 'raw_video.mp4')).size;

  const junk = path.join(root, 'junk.mp4');
  fs.writeFileSync(junk, 'this is not a video at all '.repeat(1000));
  const bad = await upload(junk, 'broken.mp4', 'video/mp4');
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /could not be read as a video/);
  const notVideo = await upload(junk, 'notes.txt', 'text/plain');
  assert.equal(notVideo.status, 400);

  const after = await api(`/projects/${id}/video`);
  assert.equal(after.status, 200);
  assert.equal(fs.statSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '00_input', 'raw_video.mp4')).size, goodSize, 'the good video is still there');
  assert.equal(fs.readdirSync(path.join(process.env.MANGO_PROJECTS_DIR!, id, '00_input')).filter((f) => f.endsWith('.part')).length, 0, 'no temp upload left');
});

test('the requirements panel reports the stand-in CLI', { skip }, async () => {
  setMode('version');
  const status = (await (await api('/status')).json()) as { checks: { id: string; state: string; summary: string }[] };
  const claude = status.checks.find((c) => c.id === 'claude')!;
  assert.ok(['ok', 'warn', 'error'].includes(claude.state));
  assert.ok(status.checks.some((c) => c.id === 'disk'));
  assert.ok(status.checks.some((c) => c.id === 'encoder'));
});

test.after(async () => {
  await stopServer();
  cleanup();
});
