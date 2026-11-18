#!/usr/bin/env node
// mangoai <command>: one entry for everything MangoAI ships.
//   mangoai start [--port 4780]   the editor (http://localhost:4780)
//   mangoai mcp                   MCP server for Claude over stdio (starts the editor server when needed)
//   mangoai hook                  Claude Code UserPromptSubmit hook: reports your saves since Claude last looked
//   mangoai setup [--yes]         register the MCP server and hook with Claude Code yourself (not needed with
//                                 the video-studio plugin, which registers both)
//   mangoai import|info|roundtrip project-file tools (see `mangoai help`)
//   mangoai version
// Developers: set MANGOAI_REPO to a MangoAI clone and `mcp` / `start` run that clone's sources instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd = 'help'] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(path.join(here, file)).href);

/** A local clone (MANGOAI_REPO) runs from source with tsx, so plugin users and developers share one config. */
function fromRepo(entry) {
  const repo = process.env.MANGOAI_REPO;
  if (!repo) return false;
  const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const main = path.join(repo, entry);
  if (!fs.existsSync(tsx) || !fs.existsSync(main)) {
    console.error(`MANGOAI_REPO=${repo} has no ${entry} or no node_modules (run npm install there); using the package.`);
    return false;
  }
  const child = spawn(process.execPath, [tsx, main, ...process.argv.slice(3)], { stdio: 'inherit', cwd: repo });
  child.on('exit', (code) => process.exit(code ?? 0));
  return true;
}

switch (cmd) {
  case 'start':
  case 'server':
    if (!fromRepo('packages/server/src/main.ts')) await load('server.js');
    break;
  case 'mcp':
    if (!fromRepo('packages/mcp/src/main.ts')) await load('mcp.js');
    break;
  case 'hook':
    await load('hook.mjs');
    break;
  case 'setup':
    await load('setup.js');
    break;
  case 'import':
  case 'info':
  case 'roundtrip':
    await load('mango.js');
    break;
  case 'version':
  case '--version':
  case '-v': {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
    break;
  }
  default:
    console.log(`mangoai <command>
  start [--port 4780]           the editor at http://localhost:4780
  mcp                           MCP server for Claude (stdio)
  hook                          Claude Code hook that reports your saves
  setup [--yes]                 register mcp + hook with Claude Code (the video-studio plugin does this for you)
  import <folder|short.json> [--out cut.json]
  info <folder|file>
  roundtrip <root>
  version`);
    if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
}
