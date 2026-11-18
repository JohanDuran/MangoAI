// Builds the publishable `mangoai` package into packages/cli/dist:
//   bin.js        the command dispatcher (src/bin.mjs)
//   server.js     the editor server       (packages/server)
//   mcp.js        Claude's MCP server     (packages/mcp)
//   setup.js      `mangoai setup`         (packages/mcp/src/install.ts)
//   mango.js      import / info / roundtrip (packages/core/src/cli.ts)
//   hook.mjs      the Claude Code hook    (packages/mcp/hook.mjs, copied as is)
//   web/          the editor UI, prebuilt with Vite (packages/web)
// Runtime dependencies (hyperframes, the MCP SDK, zod) stay external and come from package.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(cli, '..', '..');
const dist = path.join(cli, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf-8'));

// One version everywhere: packages/core/src/version.ts is what the server and MCP report.
const versionTs = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'version.ts'), 'utf-8');
const coreVersion = /VERSION = '([^']+)'/.exec(versionTs)?.[1];
if (coreVersion !== pkg.version) {
  console.error(`Version mismatch: packages/cli/package.json is ${pkg.version}, packages/core/src/version.ts is ${coreVersion}.`);
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    server: path.join(repo, 'packages/server/src/main.ts'),
    mcp: path.join(repo, 'packages/mcp/src/main.ts'),
    setup: path.join(repo, 'packages/mcp/src/install.ts'),
    mango: path.join(repo, 'packages/core/src/cli.ts'),
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // vite is only used from source (dev mode); the package serves the prebuilt dist/web instead.
  external: ['hyperframes', '@modelcontextprotocol/sdk', 'zod', 'vite'],
  logLevel: 'warning',
});

fs.copyFileSync(path.join(cli, 'src', 'bin.mjs'), path.join(dist, 'bin.js'));
fs.copyFileSync(path.join(repo, 'packages', 'mcp', 'hook.mjs'), path.join(dist, 'hook.mjs'));

const vite = path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
execFileSync(process.execPath, [vite, 'build', '--outDir', path.join(dist, 'web'), '--emptyOutDir'], {
  cwd: path.join(repo, 'packages', 'web'),
  stdio: 'inherit',
});
console.log(`mangoai ${pkg.version} built in ${path.relative(repo, dist)}`);
