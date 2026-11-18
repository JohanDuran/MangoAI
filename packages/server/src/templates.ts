// Templates: a project's set-up (format, tracks and their mix, caption style, loudness) saved to reuse for the
// next video, optionally with its clips (an intro, an outro, a music bed). Stored as
// <studio>/templates/<name>.json; files are kept by full path so they work from any project folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyProject, validateProject, type Clip, type Project } from '@mangoai/core';
import { writeProject } from '@mangoai/core/node';
import { editorFor, load } from './projects.js';

export const templatesDir = (studio: string) => path.join(studio, 'templates');

const safeName = (name: string) => {
  const n = name.trim().replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').slice(0, 60);
  if (!n) throw new Error('give the template a name (letters, digits, spaces)');
  return n;
};

export async function listTemplates(studio: string): Promise<{ name: string; tracks: number; clips: number; size: string }[]> {
  const dir = templatesDir(studio);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as Project;
      out.push({ name: f.slice(0, -5), tracks: p.tracks.length, clips: p.tracks.reduce((n, t) => n + t.clips.length, 0), size: `${p.width}×${p.height} ${p.fps} fps` });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Save the project in `dir` (as saved on disk) as a template. */
export async function saveTemplate(studio: string, dir: string, name: string, keepClips: boolean): Promise<string> {
  const st = await load(dir, true);
  const ed = editorFor(st);
  const r = ed.resolve();
  const p = ed.project;
  const abs = (src: string) => (path.isAbsolute(src) ? src : path.resolve(dir, p.sources[src] ?? src)).replace(/\\/g, '/');
  const t = emptyProject({ width: p.width, height: p.height, fps: p.fps });
  t.regions = p.regions;
  t.blurs = p.blurs;
  if (p.master) t.master = p.master;
  t.tracks = p.tracks.map((tr) => ({
    ...structuredClone(tr),
    clips: !keepClips
      ? []
      : tr.clips.flatMap((c): Clip[] => {
          // times become plain numbers: words, sections and anchors don't exist in the next project
          const rc = r.clips.get(c.id);
          if (!rc) return [];
          const x = structuredClone(c) as Clip & Record<string, unknown>;
          x.start = Math.round((rc.start + (c.pivot ?? 0)) * 1e4) / 1e4;
          if (rc.end !== null && c.end !== undefined) x.end = Math.round(rc.end * 1e4) / 1e4;
          delete x.origin;
          if (x.type === 'media') {
            x.src = abs(x.src);
            delete x.transcript;
            if (x.speedTo) {
              delete x.speedTo;
              x.in = rc.in ?? 0;
              x.speed = rc.speed ?? 1;
            } else if (typeof x.in === 'string') x.in = rc.in ?? 0;
            if (x.keys) x.keys = rc.keys ?? [];
          }
          if (x.type === 'comp') {
            x.comp = abs(x.comp);
            if (x.vars) x.vars = rc.vars ?? x.vars;
          }
          if (x.type === 'generator' && typeof x.params.image === 'string') x.params = { ...x.params, image: abs(x.params.image) };
          return [x];
        }),
  }));
  for (const tr of t.tracks) if (tr.kind === 'captions') delete tr.transcript;
  const out = path.join(templatesDir(studio), `${safeName(name)}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await writeProject(out, t);
  return out;
}

/** Start a project in `dir` from a template: writes dir/cut.json (refuses if the folder already has one). */
export async function newFromTemplate(studio: string, dir: string, name: string, title?: string): Promise<string> {
  const file = path.join(dir, 'cut.json');
  if (await fs.access(file).then(() => true, () => false)) throw new Error('this folder already has a cut.json');
  const raw = JSON.parse(await fs.readFile(path.join(templatesDir(studio), `${safeName(name)}.json`), 'utf-8')) as Project;
  raw.revision = 0;
  if (title) raw.title = title;
  const v = validateProject(raw);
  if (!v.ok) throw new Error(`the template is not valid: ${v.problems.map((x) => x.message).join('; ')}`);
  await fs.mkdir(dir, { recursive: true });
  await writeProject(file, v.project);
  return file;
}
