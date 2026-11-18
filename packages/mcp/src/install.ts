// Register MangoAI with Claude Code (user scope): the MCP server, and the hook that reports your saves.
//   npm run claude-setup            show what would change (from a clone)
//   npm run claude-setup -- --yes   do it (backs up the files it edits first)
//   mangoai setup [--yes]           the same from the installed package (npm i -g mangoai first, so the paths last)
// Not needed with the video-studio plugin: it registers MangoAI's MCP server and hook itself, and registering
// both ways gives Claude every MangoAI tool twice. See docs/ECOSYSTEM.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const yes = process.argv.includes('--yes');
const node = process.execPath;
// Bundled (the mangoai package: dist/setup.js next to dist/bin.js) or from a clone (tsx + sources).
const bundled = fs.existsSync(path.join(here, 'bin.js'));
const mcpArgs = bundled
  ? [path.join(here, 'bin.js'), 'mcp']
  : [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO, 'packages', 'mcp', 'src', 'main.ts')];
const hook = bundled ? path.join(here, 'hook.mjs') : path.join(REPO, 'packages', 'mcp', 'hook.mjs');
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const hookCommand = `"${node}" "${hook}"`;

console.log('MangoAI → Claude Code (user scope)\n');
console.log(`1. MCP server "mangoai":  ${node} ${mcpArgs.join(' ')}`);
console.log(`2. UserPromptSubmit hook in ${settingsFile}:  ${hookCommand}\n`);
if (!yes) {
  console.log('Nothing changed. Run again with --yes to do it.');
  process.exit(0);
}

// 1. MCP server, through the claude CLI so the right config file is used
try {
  execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'mangoai'], { stdio: 'ignore', shell: true });
} catch {}
execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'mangoai', '--', `"${node}"`, ...mcpArgs.map((a) => (a.includes(path.sep) ? `"${a}"` : a))], { stdio: 'inherit', shell: true });

// 2. hook
let settings: { hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]> } = {};
if (fs.existsSync(settingsFile)) {
  fs.copyFileSync(settingsFile, `${settingsFile}.mangoai-backup`);
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}
settings.hooks ??= {};
const list = (settings.hooks.UserPromptSubmit ??= []);
const already = list.some((g) => g.hooks.some((h) => h.command.includes('hook.mjs') && /mangoai/i.test(h.command)));
if (!already) list.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] });
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
console.log(already ? 'Hook was already there.' : `Hook added (backup: ${settingsFile}.mangoai-backup).`);
console.log('\nDone. Start a new Claude Code session to pick them up.');
