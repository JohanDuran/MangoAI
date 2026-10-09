// electron-builder never copies node_modules directories through extraResources, and the runtime needs
// its own (Remotion, esbuild, express and Remotion's Chrome Headless Shell in node_modules/.remotion).
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const source = path.resolve(__dirname, '..', '..', '..', 'build', 'runtime', 'node_modules');
  const target = path.join(context.appOutDir, 'resources', 'runtime', 'node_modules');
  if (!fs.existsSync(source)) throw new Error(`Runtime node_modules not found at ${source}. Run "npm run runtime" first.`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  const chrome = path.join(target, '.remotion', 'chrome-headless-shell');
  if (!fs.existsSync(chrome)) throw new Error('Chrome Headless Shell is missing from the runtime; refusing to package an app whose exports would need a download.');
  console.log(`  • runtime node_modules copied (${target})`);
};
