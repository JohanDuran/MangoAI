// MangoAI's tools for Claude (MCP over stdio). Every call goes to the local MangoAI server (started here if
// it isn't running), so edits show up live in the editor and land in cut.json as revisions by Claude.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const PORT = Number(process.env.MANGOAI_PORT) || 4780;
const BASE = `http://127.0.0.1:${PORT}`;

// --- talking to the MangoAI server ----------------------------------------------------------------
async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok && ((await r.json()) as { app?: string }).app === 'mangoai';
  } catch {
    return false;
  }
}

/** Start the server in the background when it isn't running (log: ~/.mangoai/server.log). */
async function ensureServer(): Promise<void> {
  if (await healthy()) return;
  const logDir = path.join(os.homedir(), '.mangoai');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'server.log'), 'a');
  const tsx = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, path.join(REPO, 'packages', 'server', 'src', 'main.ts'), '--port', String(PORT)], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await healthy()) return;
  }
  throw new Error(`MangoAI's server didn't start; see ${path.join(logDir, 'server.log')}`);
}

async function call<T = unknown>(method: 'GET' | 'POST', route: string, data?: Record<string, unknown>): Promise<T> {
  await ensureServer();
  let url = `${BASE}${route}`;
  const init: RequestInit = { method, headers: { 'X-Mango-Client': 'claude', 'Content-Type': 'application/json' } };
  if (method === 'GET' && data) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) q.set(k, String(v));
    url += `?${q}`;
  } else if (data) init.body = JSON.stringify(data);
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
  return body;
}

const text = (x: unknown) => ({ content: [{ type: 'text' as const, text: typeof x === 'string' ? x : JSON.stringify(x, null, 1) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });

/** A small JPEG of a still, to look at (the full PNG path is returned too). */
async function preview(file: string, width = 540): Promise<{ type: 'image'; data: string; mimeType: string } | null> {
  const out = path.join(os.tmpdir(), `mangoai-${process.pid}-${Date.now()}.jpg`);
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `scale=${width}:-2`, '-q:v', '4', '-frames:v', '1', out]);
    const data = (await fsp.readFile(out)).toString('base64');
    return { type: 'image', data, mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    await fsp.rm(out, { force: true });
  }
}

const dirArg = z.string().describe('The project folder (absolute path), e.g. C:\\Users\\me\\media-studio\\jdkoder_shorts\\Railway_AI_Keys');

// --- tools ------------------------------------------------------------------------------------------
const server = new McpServer(
  { name: 'mangoai', version: '0.1.0' },
  {
    instructions: `MangoAI is the user's video editor (a browser tab on localhost:4780). The edit lives in <project>/cut.json.
- Start with project_open (opens the editor for the user) or project_state. Times are seconds on the timeline.
- Edit with edit (move/trim/split/cut/gain/fade/link) or apply_ops, always passing base = the revision you last read.
  A refusal "changed since you last looked" means the user saved: read again, then retry.
- The user can edit by hand and Save; their saves show in changes_since and the hook reports them to you.
- Requests (requests_list) are things the user pointed at in the editor: change a comp's element, or make something new
  in a range/box. For a new animation use comp_create, write the comp's index.html, check it with comp_stills, then
  comp_edit_done. Before editing an existing comp, comp_versions action=snapshot. Set the request to done with request_update.
- Clip times can be linked: "word:so", "word:use#2.end", "s02.start + 0.3", anchor names. Link to words so a re-voice re-times.
- frame shows the live composite at a time; export renders only what changed.`,
  },
);

server.tool('project_open', 'Open a project folder in MangoAI (starts the editor and opens it in the browser if no tab has it open). Returns the project summary.', { dir: dirArg, browser: z.boolean().optional().describe('Open a browser tab when none is open (default true)') }, async ({ dir, browser }) => {
  try {
    const st = await call<{ editor: { open_tabs: number } }>('GET', '/api/state', { dir });
    if (browser !== false && st.editor.open_tabs === 0) {
      const url = `http://localhost:${PORT}/?dir=${encodeURIComponent(dir)}`;
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return text({ url: `http://localhost:${PORT}/?dir=${encodeURIComponent(dir)}`, ...st });
  } catch (e) {
    return fail(e);
  }
});

server.tool(
  'project_state',
  'The timeline: tracks and clips (with resolved times t:[start,end] and linked expressions), sections, anchors, open requests, problems, revision, and whether the editor has unsaved edits. Use from/to for long videos.',
  { dir: dirArg, from: z.number().optional(), to: z.number().optional() },
  async (a) => {
    try {
      return text(await call('GET', '/api/state', a));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool('changes_since', 'What changed since a revision (who saved, plain-language summary), plus the editor\'s unsaved edits.', { dir: dirArg, since: z.number().int() }, async (a) => {
  try {
    return text(await call('GET', '/api/changes', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('selection', 'What the user has selected in the editor right now: clips, the I/O range, a drawn box, a picked element, and the playhead.', { dir: dirArg }, async (a) => {
  try {
    return text(await call('GET', '/api/selection', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('frame', 'A still of the live composite at time t (drawn by the open editor tab; comps included). Returns the image and its path.', { dir: dirArg, t: z.number() }, async (a) => {
  try {
    const r = await call<{ path: string }>('POST', '/api/frame', a);
    const img = await preview(r.path);
    return { content: [{ type: 'text' as const, text: r.path }, ...(img ? [img] : [])] };
  } catch (e) {
    return fail(e);
  }
});

server.tool(
  'edit',
  `Edit with the same commands as the editor. command and args:
 move {ids, by | to, track?}  trim {id, edge: start|end, at}  split {at, ids?}  delete {ids}  ripple_delete {ids}
 cut_range {from, to, tracks?} (cut every unlocked track and close the gap)  cut_ranges {ranges: [[a,b],...]}
 cut_pauses {min?: 0.8, keep?: 0.15}  cut_fillers {}  gain {ids, db}  fade {ids, in?, out?}
 link {id, edge?: start|end, to: "word:so" | anchor | "s02.start"}  unlink {id, edge?}`,
  { dir: dirArg, base: z.number().int().describe('The revision you last read'), command: z.string(), args: z.record(z.unknown()).default({}), label: z.string().optional() },
  async (a) => {
    try {
      return text(await call('POST', '/api/edit', a));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'apply_ops',
  'Low-level edit: a list of ops applied as one change (all or nothing). Ops: add_track, remove_track, update_track{id,set}, add_clip{track,clip}, remove_clip{id}, update_clip{id,set} (null removes a field), move_clip{id,track}, split_clip{id,at,newId}, set_anchor{name,at}, add_section, update_section, remove_section, set_title, add_request, update_request{id,set}, remove_request. See MangoAI docs/PROJECT_FORMAT.md for clip fields.',
  { dir: dirArg, base: z.number().int(), ops: z.array(z.record(z.unknown())), label: z.string().optional() },
  async (a) => {
    try {
      return text(await call('POST', '/api/apply', a));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool('requests_list', 'The user\'s requests: what they pointed at (clip, comp element, range, box in pixels), what they want, a still, and the words spoken there.', { dir: dirArg, status: z.enum(['open', 'working', 'done', 'rejected']).optional() }, async (a) => {
  try {
    const r = await call<{ requests: { still_path?: string }[] }>('GET', '/api/requests', a);
    const imgs = [];
    for (const q of r.requests.slice(0, 4)) if (q.still_path) imgs.push(await preview(q.still_path, 360));
    return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 1) }, ...(imgs.filter(Boolean) as { type: 'image'; data: string; mimeType: string }[])] };
  } catch (e) {
    return fail(e);
  }
});

server.tool('request_update', 'Set a request\'s status (working, done, rejected) and your reply to the user.', { dir: dirArg, base: z.number().int(), id: z.string(), status: z.enum(['open', 'working', 'done', 'rejected']), reply: z.string().optional() }, async ({ dir, base, id, status, reply }) => {
  try {
    return text(await call('POST', '/api/apply', { dir, base, ops: [{ op: 'update_request', id, set: { status, ...(reply !== undefined && { reply }) } }], label: `request ${id} ${status}` }));
  } catch (e) {
    return fail(e);
  }
});

server.tool(
  'comp_create',
  'Make a new HyperFrames comp for a time range (and box): scaffolds animations/<name>/index.html sized to the frame with a stage div at the box, and places it on a free graphics track. Pass request to take the range/box from a request and mark it working. Then write the animation, check with comp_stills, and call comp_edit_done.',
  { dir: dirArg, base: z.number().int(), range: z.tuple([z.number(), z.number()]).optional(), region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('Normalized 0-1 [x,y,w,h]'), name: z.string().optional(), request: z.string().optional(), text: z.string().optional() },
  async (a) => {
    try {
      return text(await call('POST', '/api/comp/create', a));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool('comp_versions', 'Versions of a comp clip: list, snapshot (keep a copy before you edit it), or switch to version v (the user can also flip versions in the editor).', { dir: dirArg, clip: z.string(), comp: z.string().optional().describe('The comp folder (needed for snapshot/switch)'), action: z.enum(['list', 'snapshot', 'switch']), v: z.number().int().optional(), note: z.string().optional() }, async ({ dir, clip, comp, action, v, note }) => {
  try {
    if (action === 'list') return text(await call('GET', '/api/comp/versions', { dir, clip }));
    let folder = comp;
    if (!folder) {
      const st = await call<{ tracks: { clips: { id: string; comp?: string }[] | string }[] }>('GET', '/api/state', { dir });
      for (const t of st.tracks) if (Array.isArray(t.clips)) for (const c of t.clips) if (c.id === clip) folder = c.comp;
    }
    if (!folder) throw new Error(`no comp clip ${clip}`);
    return text(await call('POST', '/api/comp/versions', { dir, clip, comp: folder, action, v, note }));
  } catch (e) {
    return fail(e);
  }
});

server.tool('comp_stills', 'Render stills of one comp clip on mid-grey (default 3, spread over its length) to check it yourself before showing the user.', { dir: dirArg, clip: z.string(), n: z.number().int().optional(), times: z.array(z.number()).optional().describe('Clip-local seconds') }, async (a) => {
  try {
    const r = await call<{ stills: string[]; times: number[] }>('POST', '/api/comp/stills', a);
    const imgs = [];
    for (const f of r.stills.slice(0, 6)) imgs.push(await preview(f, 480));
    return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 1) }, ...(imgs.filter(Boolean) as { type: 'image'; data: string; mimeType: string }[])] };
  } catch (e) {
    return fail(e);
  }
});

server.tool('comp_edit_done', 'Tell the editor a comp\'s files changed so its preview reloads (the folder watcher usually catches it; call this to be sure).', { dir: dirArg, clip: z.string().optional() }, async (a) => {
  try {
    return text(await call('POST', '/api/comp/changed', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('transcript', 'Words as heard on the timeline [word, start, end], for a window and/or a search.', { dir: dirArg, from: z.number().optional(), to: z.number().optional(), q: z.string().optional() }, async (a) => {
  try {
    return text(await call('GET', '/api/transcript', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('export', 'Render the video (or just a range, for an exact check). Only changed parts and comps re-render. Waits up to `wait` seconds (default 600).', { dir: dirArg, range: z.tuple([z.number(), z.number()]).optional(), wait: z.number().optional() }, async ({ dir, range, wait }) => {
  try {
    const { job } = await call<{ job: { id: string } }>('POST', '/api/export', { dir, ...(range && { range }) });
    const done = await call('GET', '/api/export/job', { id: job.id, wait: wait ?? 600 });
    return text(done);
  } catch (e) {
    return fail(e);
  }
});

server.tool('export_plan', 'What an export would render now (cached vs stale parts, comps) and an estimate.', { dir: dirArg }, async (a) => {
  try {
    return text(await call('GET', '/api/export/plan', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('export_otio', 'Write the edit as OpenTimelineIO (.otio) to finish in DaVinci Resolve.', { dir: dirArg }, async (a) => {
  try {
    return text(await call('POST', '/api/export/otio', a));
  } catch (e) {
    return fail(e);
  }
});

server.tool('restore_revision', 'Bring back an old revision (as a new revision; nothing is lost).', { dir: dirArg, rev: z.number().int() }, async (a) => {
  try {
    return text(await call('POST', '/api/restore', a));
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
