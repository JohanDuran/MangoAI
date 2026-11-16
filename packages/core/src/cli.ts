// mango <command>
//   import <folder | short.json> [--out cut.json]   short.json -> cut.json (stdout without --out)
//   info <folder | short.json | cut.json>           resolved sections and length, like short_info
//   roundtrip <root>                                import + export every short.json under root and compare
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { exportShortJson } from './import/shortJson.js';
import { formatJson, loadWords, readJson, writeProject } from './io.js';
import { importFolder } from './node.js';
import { resolveProject } from './resolve.js';
import { validateProject, type Project } from './schema.js';

async function specPath(arg: string): Promise<{ dir: string; file: string }> {
  const abs = path.resolve(arg);
  const st = await fs.stat(abs);
  if (st.isDirectory()) {
    for (const name of ['cut.json', 'short.json']) {
      try {
        await fs.access(path.join(abs, name));
        return { dir: abs, file: path.join(abs, name) };
      } catch {}
    }
    throw new Error(`${arg}: no cut.json or short.json`);
  }
  return { dir: path.dirname(abs), file: abs };
}

async function load(arg: string) {
  const { dir, file } = await specPath(arg);
  const project = file.endsWith('short.json') ? await importFolder(dir, file) : ((await readJson(file)) as Project);
  const v = validateProject(project);
  if (!v.ok) throw new Error(`invalid project:\n${v.problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`);
  const words = await loadWords(dir, Object.values(project.transcripts)[0] ?? '');
  return { dir, file, project, words };
}

async function cmdImport(args: string[]) {
  const out = args.indexOf('--out');
  const { project } = await load(args[0]!);
  if (out >= 0) await writeProject(path.resolve(args[out + 1]!), project);
  else process.stdout.write(formatJson(project));
}

async function cmdInfo(args: string[]) {
  const { project, words } = await load(args[0]!);
  const r = resolveProject(project, words ? { words } : {});
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  console.log(`${project.title ?? '(untitled)'}: ${r.end.toFixed(2)} s, ${project.sections.length} sections, ${project.tracks.length} tracks, ${clips} clips`);
  for (const s of r.sections) console.log(`  ${s.id.padEnd(24)} ${s.t0.toFixed(2).padStart(8)} → ${s.t1.toFixed(2).padStart(8)}  frame ${Math.round(s.t0 * project.fps)}`);
  for (const t of project.tracks) console.log(`  [${t.id}] ${t.kind}${t.role ? `/${t.role}` : ''} ${t.name ?? ''}: ${t.clips.length} clips`);
  for (const p of r.problems) console.log(`  ! ${p.path}: ${p.message}`);
}

async function findSpecs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['_archive', 'node_modules', '.git', '_scratch', 'recordings'].includes(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(d, e.name));
      } else if (e.name === 'short.json') out.push(path.join(d, e.name));
    }
  };
  await walk(root);
  return out.sort();
}

function firstDiff(a: unknown, b: unknown, at = ''): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at || '(root)'}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
}

async function cmdRoundtrip(args: string[]) {
  const root = path.resolve(args[0] ?? '.');
  const specs = await findSpecs(root);
  let failed = 0;
  for (const file of specs) {
    const rel = path.relative(root, file);
    try {
      const original = await readJson(file);
      const project = await importFolder(path.dirname(file), file);
      const v = validateProject(JSON.parse(JSON.stringify(project)));
      if (!v.ok) throw new Error(v.problems.map((p) => `${p.path}: ${p.message}`).join('; '));
      const words = await loadWords(path.dirname(file), project.transcripts.voice ?? '');
      const r = resolveProject(project, words ? { words } : {});
      // write → read → export, so what's compared went through the file format
      const back = exportShortJson(JSON.parse(formatJson(project)) as Project);
      const diff = firstDiff(original, back);
      if (diff) throw new Error(`not lossless at ${diff}`);
      const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
      const sfxTracks = project.tracks.filter((t) => t.role === 'sfx').length;
      const warn = r.problems.length ? `  (${r.problems.length} unresolved: ${r.problems[0]!.message})` : '';
      console.log(`ok    ${rel.padEnd(52)} ${r.end.toFixed(2).padStart(7)} s  ${String(clips).padStart(3)} clips  ${sfxTracks} sfx tracks${warn}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${rel}: ${(e as Error).message}`);
    }
  }
  console.log(`\n${specs.length - failed}/${specs.length} lossless`);
  if (failed) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = { import: cmdImport, info: cmdInfo, roundtrip: cmdRoundtrip };
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.error('usage: mango import <folder|short.json> [--out cut.json] | info <folder|file> | roundtrip <root>');
  process.exitCode = 2;
} else {
  fn(rest).catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
