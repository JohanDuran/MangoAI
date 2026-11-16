// Register MangoAI with Claude Code (user scope): the MCP server, and the hook that reports your saves.
//   npm run claude-setup            show what would change
//   npm run claude-setup -- --yes   do it (backs up the files it edits first)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const yes = process.argv.includes('--yes');
const node = process.execPath;
const tsx = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const mcpMain = path.join(REPO, 'packages', 'mcp', 'src', 'main.ts');
const hook = path.join(REPO, 'packages', 'mcp', 'hook.mjs');
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const hookCommand = `"${node}" "${hook}"`;

console.log('MangoAI → Claude Code (user scope)\n');
console.log(`1. MCP server "mangoai":  ${node} ${tsx} ${mcpMain}`);
console.log(`2. UserPromptSubmit hook in ${settingsFile}:  ${hookCommand}\n`);
if (!yes) {
  console.log('Nothing changed. Run again with --yes to do it.');
  process.exit(0);
}

// 1. MCP server, through the claude CLI so the right config file is used
try {
  execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'mangoai'], { stdio: 'ignore', shell: true });
} catch {}
execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'mangoai', '--', `"${node}"`, `"${tsx}"`, `"${mcpMain}"`], { stdio: 'inherit', shell: true });

// 2. hook
let settings: { hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]> } = {};
if (fs.existsSync(settingsFile)) {
  fs.copyFileSync(settingsFile, `${settingsFile}.mangoai-backup`);
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}
settings.hooks ??= {};
const list = (settings.hooks.UserPromptSubmit ??= []);
const already = list.some((g) => g.hooks.some((h) => h.command.includes('hook.mjs') && h.command.includes('MangoAI')));
if (!already) list.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] });
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
console.log(already ? 'Hook was already there.' : `Hook added (backup: ${settingsFile}.mangoai-backup).`);
console.log('\nDone. Start a new Claude Code session to pick them up.');
