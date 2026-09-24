// Builds build/runtime: everything the installed app runs besides Electron itself.
//   build/runtime/server.mjs      the runner, bundled and minified
//   build/runtime/editor/         the built editor
//   build/runtime/templates|skills
//   build/runtime/node_modules/   production dependencies (incl. Remotion's Chrome Headless Shell)
//   build/runtime/bin/            ffmpeg + ffprobe with their licenses
// Usage: node scripts/build-runtime.mjs [--runner-only] [--skip-install]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'runtime');
const cache = path.join(root, 'build', 'cache');
const require = createRequire(path.join(root, 'package.json'));
const esbuild = require('esbuild');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';

// A pinned ffmpeg build (GPL, with libx264 and NVENC). The hash is verified after every download.
const FFMPEG = {
  version: '6.1.1',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/6.1.1/ffmpeg-6.1.1-essentials_build.zip',
  sha256: '742e32fc9f92681f9f254b925e1b613fdd8074ba40749d4879aefdb009b94cc5',
  dir: 'ffmpeg-6.1.1-essentials_build',
};

const log = (msg) => console.log(`[runtime] ${msg}`);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', shell: isWin && /\.cmd$|^npm$|^npx$/.test(cmd), ...opts });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      https
        .get(u, { headers: { 'User-Agent': 'mangoai-build' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 5) return reject(new Error('too many redirects'));
            res.resume();
            return get(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) return reject(new Error(`GET ${u} -> ${res.statusCode}`));
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function buildRunner() {
  log('bundling the runner');
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/runner/src/index.ts')],
    outfile: path.join(out, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Dependencies stay in node_modules: Remotion, esbuild and express load native files and dynamic modules.
    packages: 'external',
    minify: true,
    legalComments: 'none',
    sourcemap: 'external',
    logLevel: 'warning',
  });
  // The source map is for debugging crashes reported by users; it is not part of the installer.
  const map = path.join(out, 'server.mjs.map');
  if (fs.existsSync(map)) {
    fs.mkdirSync(path.join(root, 'build', 'symbols'), { recursive: true });
    fs.renameSync(map, path.join(root, 'build', 'symbols', 'server.mjs.map'));
  }
}

function buildEditor() {
  log('building the editor');
  run('npm', ['run', 'build', '-w', '@mangoai/editor'], { cwd: root });
  fs.cpSync(path.join(root, 'apps/editor/dist'), path.join(out, 'editor'), { recursive: true });
}

function copyResources() {
  log('copying templates and skills');
  fs.cpSync(path.join(root, 'apps/runner/templates'), path.join(out, 'templates'), { recursive: true });
  fs.cpSync(path.join(root, 'skills'), path.join(out, 'skills'), { recursive: true });
}

// The overlay library is TypeScript source in the repo. Webpack (used for exports) does not compile
// TypeScript inside node_modules, so the installed copy is a plain JavaScript build.
async function buildOverlayPackage() {
  log('building the overlay library');
  const pkgDir = path.join(root, 'packages/remotion-overlay');
  const target = path.join(out, 'node_modules', '@mangoai', 'remotion-overlay');
  fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(pkgDir, 'src/index.ts')],
    outfile: path.join(target, 'dist/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'remotion', '@remotion/*'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: 'dist/index.js', module: 'dist/index.js', peerDependencies: { react: '*', remotion: '*' } }, null, 2)
  );
}

function installDependencies() {
  log('installing production dependencies');
  const runnerPkg = readJson(path.join(root, 'apps/runner/package.json'));
  const installedVersion = (name) => readJson(path.join(root, 'node_modules', name, 'package.json')).version;
  // Exact versions, taken from what the repository is developed and tested with.
  const names = [...Object.keys(runnerPkg.dependencies).filter((n) => !n.startsWith('@mangoai/')), 'esbuild', 'react', 'react-dom', 'remotion'];
  const dependencies = Object.fromEntries([...new Set(names)].map((n) => [n, installedVersion(n)]));
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'mangoai-runtime', version: '0.0.0', private: true, type: 'module', dependencies }, null, 2));

  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--package-lock=false'], { cwd: out });
}

function pruneNodeModules() {
  log('pruning node_modules');
  const nm = path.join(out, 'node_modules');
  let removed = 0;
  const junk = /\.(map|md|markdown|ts|tsx|flow)$|(^|[\\/])(LICENSE|CHANGELOG|README|HISTORY)(\.[a-z]+)?$/i;
  const keepTs = /\.d\.ts$/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.remotion' || entry.name === '.bin') continue;
        if (/^(test|tests|__tests__|docs|example|examples|\.github)$/.test(entry.name)) {
          rm(full);
          removed++;
        } else walk(full);
      } else if (junk.test(entry.name) && !/^LICENSE/i.test(entry.name) && !keepTs.test(entry.name)) {
        fs.rmSync(full, { force: true });
        removed++;
      }
    }
  };
  walk(nm);
  log(`pruned ${removed} files`);
}

// Remotion renders with its own Chrome Headless Shell, which it normally downloads on the first
// export. Shipping it means exports work offline and behind restrictive networks.
function fetchChromeShell() {
  log('downloading Chrome Headless Shell for Remotion');
  const script = "require('@remotion/renderer').ensureBrowser().then(()=>console.log('chrome ready'))";
  run(process.execPath, ['-e', script], { cwd: out, env: { ...process.env } });
  const found = path.join(out, 'node_modules', '.remotion');
  if (!fs.existsSync(found)) throw new Error('Chrome Headless Shell was not downloaded into node_modules/.remotion');
}

async function fetchFfmpeg() {
  log(`preparing ffmpeg ${FFMPEG.version}`);
  fs.mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, `ffmpeg-${FFMPEG.version}.zip`);
  if (!fs.existsSync(zip) || sha256(zip) !== FFMPEG.sha256) {
    log('downloading ffmpeg (about 85 MB)');
    await download(FFMPEG.url, zip);
  }
  if (sha256(zip) !== FFMPEG.sha256) throw new Error('ffmpeg download does not match the pinned SHA-256');
  const tmp = path.join(cache, 'ffmpeg-extract');
  rm(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  // bsdtar ships with Windows 10+ and reads zip archives.
  run(isWin ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', zip, '-C', tmp]);
  const bin = path.join(out, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const src = path.join(tmp, FFMPEG.dir);
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(src, 'bin', f), path.join(bin, f));
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(bin, 'FFMPEG-LICENSE.txt'));
  fs.writeFileSync(
    path.join(bin, 'FFMPEG-NOTICE.txt'),
    `MangoAI includes FFmpeg ${FFMPEG.version} (essentials build by gyan.dev), a separate program that MangoAI starts to process video and audio.\n` +
      `This build is licensed under the GNU General Public License version 3 (see FFMPEG-LICENSE.txt) and includes libx264 and other components.\n\n` +
      `FFmpeg source code: https://ffmpeg.org/download.html (release ${FFMPEG.version})\n` +
      `Build recipe and component sources: https://www.gyan.dev/ffmpeg/builds/ and https://github.com/GyanD/codexffmpeg\n` +
      `The exact binaries shipped here were downloaded from ${FFMPEG.url}\n`
  );
  rm(tmp);
}

async function main() {
  if (!args.has('--skip-clean') && !args.has('--runner-only')) {
    for (const entry of fs.existsSync(out) ? fs.readdirSync(out) : []) {
      // node_modules is expensive to rebuild (Chrome download) and is refreshed by npm install.
      if (entry !== 'node_modules') rm(path.join(out, entry));
    }
  }
  fs.mkdirSync(out, { recursive: true });
  await buildRunner();
  if (args.has('--runner-only')) return;
  buildEditor();
  copyResources();
  if (!args.has('--skip-install')) installDependencies();
  await buildOverlayPackage();
  pruneNodeModules();
  if (!fs.existsSync(path.join(out, 'node_modules', '.remotion'))) fetchChromeShell();
  await fetchFfmpeg();
  log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
