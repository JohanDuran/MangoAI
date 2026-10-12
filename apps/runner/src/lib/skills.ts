import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_ROOT, projectDir } from './paths.js';

export const SKILL_SCHEMA_VERSION = 1;

export interface SkillManifest {
  schemaVersion: number;
  name: string;
  // Only installed for a call whose request explicitly lists it (e.g. paid or slow tools).
  optIn?: boolean;
  // Secrets the skill's MCP server needs. Only present in claude's environment while the skill is active.
  env?: string[];
  // npm packages the generated marker code may import besides react and remotion.
  packages?: string[];
  // Extra files (relative to the skill folder) copied next to SKILL.md in every project.
  files?: string[];
  mcp?: { server: string; tools: string[] };
}

export interface Skill {
  name: string;
  dir: string;
  // Built-in skills ship in this repository. External ones come from MANGOAI_SKILLS_DIRS and
  // run arbitrary local code, so they are never enabled by default.
  origin: 'builtin' | 'external';
  description: string;
  manifest: SkillManifest;
  missingEnv: string[];
}

export interface SkillProblem {
  folder: string;
  error: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const TOOL_RE = /^[A-Za-z0-9_]+$/;
const BASE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
// Lets Claude research the facts a prompt asks about. Pre-approved (headless runs cannot
// prompt), which is safe because neither tool can touch local files.
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const MANAGED_MARKER = '.mangoai-managed';

// Where the runner can be reached, as written into generated code and skill files. Set by the
// server once it knows its real port (the desktop app picks a free one).
export const runnerUrl = () => `http://${process.env.MANGO_HOST || 'localhost'}:${process.env.PORT || 5175}`;

function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

const isInside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function loadSkill(dir: string, folder: string, origin: Skill['origin']): Skill {
  const manifestPath = path.join(dir, 'skill.json');
  if (!fs.existsSync(manifestPath)) throw new Error('missing skill.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`skill.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  if (raw.schemaVersion !== SKILL_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (this runner supports ${SKILL_SCHEMA_VERSION})`);
  }
  const name = raw.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('"name" must be lowercase words joined by hyphens');
  if (name !== folder) throw new Error(`"name" (${name}) must match the folder name (${folder})`);

  const stringList = (key: string, pattern?: RegExp): string[] => {
    const value = raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) throw new Error(`"${key}" must be a list of strings`);
    if (pattern) for (const v of value as string[]) if (!pattern.test(v)) throw new Error(`"${key}" has an invalid entry: ${v}`);
    return value as string[];
  };
  const env = stringList('env', ENV_RE);
  const packages = stringList('packages');
  const files = stringList('files');
  for (const f of files) {
    const abs = path.resolve(dir, f);
    if (!isInside(dir, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`"files" entry not found inside the skill folder: ${f}`);
  }

  let mcp: SkillManifest['mcp'];
  if (raw.mcp !== undefined) {
    const m = raw.mcp as { server?: unknown; tools?: unknown };
    if (!m || typeof m.server !== 'string' || !Array.isArray(m.tools) || m.tools.length === 0 || m.tools.some((t) => typeof t !== 'string' || !TOOL_RE.test(t))) {
      throw new Error('"mcp" must be { "server": "<file>", "tools": ["tool_name", ...] } with at least one tool');
    }
    const abs = path.resolve(dir, m.server);
    if (!isInside(dir, abs) || !fs.existsSync(abs)) throw new Error(`"mcp.server" not found inside the skill folder: ${m.server}`);
    mcp = { server: m.server, tools: m.tools as string[] };
  }
  if (raw.optIn !== undefined && typeof raw.optIn !== 'boolean') throw new Error('"optIn" must be true or false');

  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error('missing SKILL.md');
  const front = parseFrontmatter(fs.readFileSync(skillMd, 'utf-8'));
  if (front.name !== name) throw new Error(`SKILL.md frontmatter "name" must be ${name}`);
  if (!front.description) throw new Error('SKILL.md frontmatter needs a "description" (Claude uses it to decide when to load the skill)');

  return {
    name,
    dir,
    origin,
    description: front.description,
    manifest: { schemaVersion: SKILL_SCHEMA_VERSION, name, optIn: raw.optIn as boolean | undefined, env, packages, files, mcp },
    missingEnv: env.filter((k) => !process.env[k]),
  };
}

export function discoverSkills(): { skills: Skill[]; problems: SkillProblem[] } {
  const roots: { dir: string; origin: Skill['origin'] }[] = [{ dir: SKILLS_ROOT, origin: 'builtin' }];
  for (const extra of (process.env.MANGOAI_SKILLS_DIRS ?? '').split(path.delimiter).filter(Boolean)) {
    roots.push({ dir: path.resolve(extra), origin: 'external' });
  }

  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      try {
        const skill = loadSkill(path.join(root.dir, entry.name), entry.name, root.origin);
        if (seen.has(skill.name)) throw new Error('another skill with this name was already loaded');
        seen.add(skill.name);
        skills.push(skill);
      } catch (err) {
        problems.push({ folder: path.join(root.dir, entry.name), error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { skills, problems };
}

export const defaultSkillNames = (): string[] =>
  discoverSkills().skills.filter((s) => s.origin === 'builtin').map((s) => s.name);

// Serves files from a skill's public/ folder. Returns null for anything outside it.
export function skillPublicFile(skillName: string, relativePath: string): string | null {
  const skill = discoverSkills().skills.find((s) => s.name === skillName);
  if (!skill) return null;
  const publicDir = path.join(skill.dir, 'public');
  const abs = path.resolve(publicDir, relativePath);
  if (!isInside(publicDir, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

const mcpServerKey = (skillName: string) => skillName.replace(/[^A-Za-z0-9]/g, '_');

// Writes only when the content differs. Runs with the same skills share the installed files, and an
// unconditional rewrite could let a running Claude read a file in the moment it is truncated.
function writeIfChanged(file: string, content: string | Buffer): void {
  const wanted = typeof content === 'string' ? Buffer.from(content) : content;
  try {
    if (fs.readFileSync(file).equals(wanted)) return;
  } catch {
    // missing: write it
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, wanted);
  fs.renameSync(tmp, file);
}

function installSkills(id: string, active: Skill[]): void {
  const root = path.join(projectDir(id), '.claude', 'skills');
  fs.mkdirSync(root, { recursive: true });

  const keep = new Set(active.map((s) => s.name));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.has(entry.name) && fs.existsSync(path.join(root, entry.name, MANAGED_MARKER))) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }

  for (const skill of active) {
    const target = path.join(root, skill.name);
    fs.mkdirSync(target, { recursive: true });
    const text = fs
      .readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf-8')
      .replaceAll('{{SKILL_URL}}', `${runnerUrl()}/skills/${skill.name}/public`);
    writeIfChanged(path.join(target, 'SKILL.md'), text);
    for (const file of skill.manifest.files ?? []) {
      fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
      writeIfChanged(path.join(target, file), fs.readFileSync(path.join(skill.dir, file)));
    }
    writeIfChanged(path.join(target, MANAGED_MARKER), 'managed by the MangoAI runner; regenerated before every Claude call\n');
  }
}

export interface ClaudeCallConfig {
  // Built-in tools Claude may use (--tools). Deliberately NOT passed to --allowedTools: a bare
  // "Read" or "Write" allow rule grants access to any path on the machine, whereas the default
  // permissions confine them to the project directory (verified empirically).
  tools: string[];
  // Pre-approved MCP tools only (--allowedTools), one entry per declared tool.
  allowedTools: string[];
  mcpConfigPath?: string;
  // Secrets of skills that are not active for this call; removed from claude's environment.
  envExclude: string[];
  validatorExternals: string[];
  activeSkills: string[];
  skipped: { name: string; reason: string }[];
}

// The imports the validator accepts for code the runner writes itself, outside a Claude call: the
// packages of every skill, since a shared component may use any of them.
export function allSkillExternals(): string[] {
  const packages = discoverSkills().skills.flatMap((s) => s.manifest.packages ?? []);
  return [...packages, ...packages.map((p) => `${p}/*`)];
}

// Everything per-call that depends on skills: which skills are installed for Claude to see,
// which tools it may use, the generated MCP config, and which imports the validator accepts.
export function prepareClaudeCall(opts: { projectId: string; enabled: string[]; optedIn: string[] }): ClaudeCallConfig {
  const { skills } = discoverSkills();
  const active: Skill[] = [];
  const skipped: ClaudeCallConfig['skipped'] = [];

  for (const skill of skills) {
    if (!opts.enabled.includes(skill.name)) continue;
    if (skill.manifest.optIn && !opts.optedIn.includes(skill.name)) continue;
    if (skill.missingEnv.length > 0) {
      skipped.push({ name: skill.name, reason: `missing ${skill.missingEnv.join(', ')}` });
      continue;
    }
    active.push(skill);
  }

  installSkills(opts.projectId, active);

  const tools = [...BASE_TOOLS, ...WEB_TOOLS];
  if (active.length > 0) tools.push('Skill');
  const allowedTools: string[] = [...WEB_TOOLS];

  const servers: Record<string, unknown> = {};
  for (const skill of active) {
    if (!skill.manifest.mcp) continue;
    const key = mcpServerKey(skill.name);
    // Declared secrets are not written here: the server inherits them from claude's environment,
    // so no file inside the project (which Claude can read) ever contains a key.
    // ELECTRON_RUN_AS_NODE lets the desktop app's own executable act as the node runtime here, since
    // a machine that installed MangoAI does not necessarily have node on its PATH.
    const env = { MANGOAI_PROJECT_DIR: projectDir(opts.projectId), MANGOAI_RUNNER_URL: runnerUrl(), ELECTRON_RUN_AS_NODE: '1' };
    servers[key] = { command: process.execPath, args: [path.resolve(skill.dir, skill.manifest.mcp.server)], env };
    for (const tool of skill.manifest.mcp.tools) allowedTools.push(`mcp__${key}__${tool}`);
  }

  let mcpConfigPath: string | undefined;
  if (Object.keys(servers).length > 0) {
    mcpConfigPath = path.join(projectDir(opts.projectId), '.claude', 'mcp.generated.json');
    writeIfChanged(mcpConfigPath, JSON.stringify({ mcpServers: servers }, null, 2));
  }

  const activeKeys = new Set(active.flatMap((s) => s.manifest.env ?? []));
  const envExclude = [...new Set(skills.flatMap((s) => s.manifest.env ?? []))].filter((k) => !activeKeys.has(k));

  const packages = active.flatMap((s) => s.manifest.packages ?? []);
  return {
    tools,
    allowedTools,
    mcpConfigPath,
    envExclude,
    validatorExternals: [...packages, ...packages.map((p) => `${p}/*`)],
    activeSkills: active.map((s) => s.name),
    skipped,
  };
}
