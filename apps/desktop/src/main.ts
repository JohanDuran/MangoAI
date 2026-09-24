import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PREFERRED_PORT = 47175;
const RUNNER_START_TIMEOUT_MS = 45_000;
const HOST = '127.0.0.1';
const SMOKE = process.argv.includes('--smoke-test');

// ---------------------------------------------------------------- paths

const dataRoot = app.getPath('userData');
const projectsDir = process.env.MANGO_PROJECTS_DIR ? path.resolve(process.env.MANGO_PROJECTS_DIR) : path.join(dataRoot, 'projects');
const logsDir = path.join(dataRoot, 'logs');
const settingsFile = path.join(dataRoot, 'settings.json');
const secretsFile = path.join(dataRoot, 'secrets.json');

// Installed: <install>/resources/runtime. From a checkout (npm run dev in apps/desktop): build/runtime.
const runtimeDir = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '..', '..', '..', 'build', 'runtime');
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow: BrowserWindow | null = null;
let runner: ChildProcess | null = null;
let runnerPort = 0;
let quitting = false;
let restarts: number[] = [];
let runnerOutput = '';

// ---------------------------------------------------------------- settings and secrets

interface Settings {
  bounds?: { x?: number; y?: number; width: number; height: number };
  maximized?: boolean;
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(next: Settings): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  } catch {
    // Window position is a convenience; failing to save it must not matter.
  }
}

// The OpenAI key is stored encrypted with the operating system's user-bound storage (DPAPI on
// Windows), never as plain text on disk.
function readOpenAIKey(): string | null {
  try {
    const stored = JSON.parse(fs.readFileSync(secretsFile, 'utf-8')) as { openai?: string };
    if (!stored.openai || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(stored.openai, 'base64'));
  } catch {
    return null;
  }
}

function writeOpenAIKey(key: string | null): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  if (key === null) {
    fs.rmSync(secretsFile, { force: true });
    return;
  }
  fs.writeFileSync(secretsFile, JSON.stringify({ openai: safeStorage.encryptString(key).toString('base64') }));
}

// ---------------------------------------------------------------- runner process

function pickPort(preferred: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(port, HOST, () => {
        const actual = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(actual));
      });
    });
  // A fixed port keeps the address (and with it the editor's browser storage) the same between launches.
  return tryListen(preferred).catch(() => tryListen(0));
}

function startRunner(): Promise<number> {
  return new Promise(async (resolve, reject) => {
    const port = await pickPort(runnerPort || PREFERRED_PORT);
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MANGO_PACKAGED: '1',
      MANGO_APP_VERSION: app.getVersion(),
      MANGO_RESOURCES_DIR: runtimeDir,
      MANGO_NODE_MODULES: path.join(runtimeDir, 'node_modules'),
      MANGO_PROJECTS_DIR: projectsDir,
      MANGO_LOG_DIR: logsDir,
      MANGO_CACHE_DIR: path.join(dataRoot, 'cache'),
      MANGO_FFMPEG: path.join(runtimeDir, 'bin', 'ffmpeg.exe'),
      MANGO_FFPROBE: path.join(runtimeDir, 'bin', 'ffprobe.exe'),
      MANGO_HOST: HOST,
      PORT: String(port),
    };
    const key = readOpenAIKey();
    if (key) env.OPENAI_API_KEY = key;
    else delete env.OPENAI_API_KEY;

    runnerOutput = '';
    const child = fork(path.join(runtimeDir, 'server.mjs'), [], {
      execPath: process.execPath,
      env,
      cwd: dataRoot,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    } as ForkOptions & { windowsHide: boolean });
    runner = child;

    const remember = (chunk: Buffer) => {
      runnerOutput = (runnerOutput + chunk.toString()).slice(-6000);
    };
    child.stdout?.on('data', remember);
    child.stderr?.on('data', remember);

    const timer = setTimeout(() => {
      reject(new Error('The MangoAI engine did not start in time.'));
      killRunner();
    }, RUNNER_START_TIMEOUT_MS);

    child.on('message', (message: { type?: string; port?: number; message?: string }) => {
      if (message?.type === 'ready' && message.port) {
        clearTimeout(timer);
        runnerPort = message.port;
        resolve(message.port);
      } else if (message?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(message.message ?? 'The MangoAI engine failed to start.'));
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (runner === child) runner = null;
      if (quitting) return;
      void onRunnerExit(code);
    });
  });
}

function killRunner(): void {
  const child = runner;
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  try {
    child.send({ type: 'shutdown' });
  } catch {
    // channel already closed
  }
  const pid = child.pid;
  // Give it a moment to stop Claude/ffmpeg itself, then end whatever is left of the process tree.
  setTimeout(() => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }, 2500).unref();
}

async function onRunnerExit(code: number | null): Promise<void> {
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 60_000);
  if (restarts.length < 2) {
    restarts.push(now);
    try {
      await startRunner();
      mainWindow?.loadURL(`http://${HOST}:${runnerPort}/`);
      return;
    } catch {
      // fall through to the dialog
    }
  }
  const choice = await dialog.showMessageBox({
    type: 'error',
    title: 'MangoAI',
    message: 'The MangoAI engine stopped unexpectedly.',
    detail: `Exit code ${code ?? 'unknown'}. Your projects are safe. Details are in the log folder:\n${logsDir}`,
    buttons: ['Restart', 'Open log folder', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice.response === 0) {
    restarts = [];
    try {
      await startRunner();
      mainWindow?.loadURL(`http://${HOST}:${runnerPort}/`);
    } catch (err) {
      await fatal(err);
    }
  } else if (choice.response === 1) {
    await shell.openPath(logsDir);
    app.quit();
  } else {
    app.quit();
  }
}

async function fatal(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (SMOKE) {
    console.error(`SMOKE FAIL: ${message}\n${runnerOutput}`);
    app.exit(1);
    return;
  }
  await dialog.showMessageBox({
    type: 'error',
    title: 'MangoAI could not start',
    message,
    detail: `${runnerOutput ? runnerOutput.slice(-800) + '\n\n' : ''}Log folder: ${logsDir}`,
    buttons: ['Quit'],
  });
  app.exit(1);
}

// ---------------------------------------------------------------- window

function createWindow(url: string): BrowserWindow {
  const saved = readSettings();
  const win = new BrowserWindow({
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 900,
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    title: 'MangoAI',
    backgroundColor: '#16171d',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // The editor is the only page this window may show; everything else opens in the default browser.
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(`http://${HOST}:${runnerPort}`)) {
      event.preventDefault();
      openExternalSafe(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternalSafe(target);
    return { action: 'deny' };
  });

  const persist = () => {
    if (win.isDestroyed()) return;
    writeSettings({ bounds: win.isMaximized() ? readSettings().bounds : win.getBounds(), maximized: win.isMaximized() });
  };
  win.on('close', persist);

  win.loadURL(url).catch(() => {
    // A failed load (runner restarting) is retried by onRunnerExit.
  });
  return win;
}

function openExternalSafe(target: string): void {
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.toString());
  } catch {
    // ignore malformed URLs
  }
}

// ---------------------------------------------------------------- IPC

const fromOurPage = (event: IpcMainInvokeEvent): boolean => event.senderFrame?.url.startsWith(`http://${HOST}:${runnerPort}/`) ?? false;

async function runnerFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://${HOST}:${runnerPort}${pathname}`, init);
}

async function validateOpenAIKey(key: string): Promise<{ ok: boolean; validated: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true, validated: true };
    if (res.status === 401 || res.status === 403) return { ok: false, validated: true, error: 'OpenAI rejected this key. Check that you copied all of it.' };
    return { ok: true, validated: false };
  } catch {
    // Offline or blocked: the key may still be fine, so it is saved and checked again later.
    return { ok: true, validated: false };
  }
}

function tailOfLog(bytes: number): string {
  const file = path.join(logsDir, 'runner.log');
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf-8');
  } catch {
    return '(no log file)';
  }
}

async function buildDiagnostics(): Promise<string> {
  let status = '(runner not reachable)';
  try {
    status = JSON.stringify(await (await runnerFetch('/status')).json(), null, 2);
  } catch {
    // reported as not reachable
  }
  let projectCount = 0;
  try {
    projectCount = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    // no projects folder yet
  }
  return [
    `MangoAI diagnostics - ${new Date().toISOString()}`,
    '',
    `App version: ${app.getVersion()}`,
    `Electron: ${process.versions.electron}  Chromium: ${process.versions.chrome}  Node: ${process.versions.node}`,
    `OS: ${os.type()} ${os.release()} (${os.arch()})  RAM: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB  CPUs: ${os.cpus().length}`,
    `Projects folder: ${projectsDir}  (${projectCount} projects)`,
    `OpenAI key stored: ${readOpenAIKey() ? 'yes' : 'no'}`,
    '',
    '--- Status ---',
    status,
    '',
    '--- Last part of runner.log ---',
    tailOfLog(400_000),
  ].join('\n');
}

async function exportDiagnostics(): Promise<{ saved: boolean; file?: string }> {
  const options = {
    title: 'Save diagnostics',
    defaultPath: path.join(app.getPath('desktop'), `mangoai-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  };
  const target = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (target.canceled || !target.filePath) return { saved: false };
  fs.writeFileSync(target.filePath, await buildDiagnostics());
  return { saved: true, file: target.filePath };
}

function registerIpc(): void {
  const guard = <T extends unknown[], R>(fn: (...args: T) => R | Promise<R>) => async (event: IpcMainInvokeEvent, ...args: T): Promise<R> => {
    if (!fromOurPage(event)) throw new Error('Not allowed');
    return fn(...args);
  };

  ipcMain.handle('desktop:info', guard(() => ({
    version: app.getVersion(),
    platform: process.platform,
    projectsDir,
    logsDir,
    secureStorage: safeStorage.isEncryptionAvailable(),
    hasOpenAIKey: readOpenAIKey() !== null,
  })));

  ipcMain.handle('desktop:set-openai-key', guard(async (key: unknown) => {
    if (typeof key !== 'string' || key.trim().length < 8 || /\s/.test(key.trim())) return { ok: false, error: 'That does not look like an API key.' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'This system has no secure storage available, so the key cannot be saved safely.' };
    const trimmed = key.trim();
    const check = await validateOpenAIKey(trimmed);
    if (!check.ok) return check;
    writeOpenAIKey(trimmed);
    const res = await runnerFetch('/settings/openai-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: trimmed }) });
    if (!res.ok) return { ok: false, error: 'Saved, but the engine did not accept the key. Restart MangoAI.' };
    return { ok: true, validated: check.validated };
  }));

  ipcMain.handle('desktop:clear-openai-key', guard(async () => {
    writeOpenAIKey(null);
    await runnerFetch('/settings/openai-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: null }) });
    return { ok: true };
  }));

  ipcMain.handle('desktop:open-folder', guard(async (which: unknown) => {
    const target = which === 'logs' ? logsDir : which === 'projects' ? projectsDir : null;
    if (target) await shell.openPath(target);
  }));

  ipcMain.handle('desktop:show-in-folder', guard((file: unknown) => {
    if (typeof file !== 'string') return false;
    const resolved = path.resolve(file);
    const rel = path.relative(projectsDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    shell.showItemInFolder(resolved);
    return true;
  }));

  ipcMain.handle('desktop:open-external', guard((url: unknown) => {
    if (typeof url === 'string') openExternalSafe(url);
  }));

  ipcMain.handle('desktop:export-diagnostics', guard(() => exportDiagnostics()));
}

// ---------------------------------------------------------------- menu

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open projects folder', click: () => void shell.openPath(projectsDir) },
        { label: 'Open log folder', click: () => void shell.openPath(logsDir) },
        { label: 'Save diagnostics…', click: () => void exportDiagnostics() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Check requirements (Claude, OpenAI, ffmpeg)', click: () => mainWindow?.webContents.send('desktop:open-status') },
        { label: 'Third-party notices', click: () => void shell.openPath(path.join(runtimeDir, 'THIRD-PARTY-NOTICES.txt')) },
        {
          label: 'About MangoAI',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'About MangoAI',
              message: `MangoAI ${app.getVersion()}`,
              detail: `AI video overlay studio.\n\nData folder: ${dataRoot}\nElectron ${process.versions.electron}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- smoke test (used by CI and by hand)

async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const problems: string[] = [];
  win.webContents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string | number; message: string };
    if ((level === 'error' || level === 3) && /Content Security Policy|Refused to|Failed to load module|overlay/i.test(message)) problems.push(message.slice(0, 200));
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let projectId: string | null = null;
  try {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
    await wait(2000);
    const page = (await win.webContents.executeJavaScript(
      `({ shared: Object.keys(window.__MANGO_SHARED__ || {}).length, rootChildren: document.getElementById('root')?.children.length ?? 0, bridge: typeof window.mangoDesktop })`
    )) as { shared: number; rootChildren: number; bridge: string };
    const health = (await (await runnerFetch('/health')).json()) as { ok: boolean };

    // Open a real project so the overlay bundle, the Remotion Player and the CSP are exercised together.
    const json = { 'Content-Type': 'application/json' };
    const created = (await (await runnerFetch('/projects', { method: 'POST', headers: json, body: JSON.stringify({ name: 'smoke', baseLayer: { type: 'transparent' }, width: 640, height: 360, durationInFrames: 60 }) })).json()) as { id: string };
    projectId = created.id;
    await runnerFetch(`/projects/${projectId}/markers`, { method: 'POST', headers: json, body: JSON.stringify({ start: 0, end: 1.5, prompt: 'Smoke test' }) });
    await win.loadURL(`http://${HOST}:${runnerPort}/?project=${projectId}`);
    await wait(4000);
    const player = (await win.webContents.executeJavaScript(`!!document.querySelector('.__remotion-player')`)) as boolean;

    // A real export exercises Remotion's bundler, its Chrome Headless Shell and the ffmpeg build from the install folder.
    let exportState = 'skipped';
    if (!process.argv.includes('--no-export')) {
      await runnerFetch(`/projects/${projectId}/export`, { method: 'POST', headers: json, body: JSON.stringify({}) });
      const deadline = Date.now() + 240_000;
      exportState = 'running';
      while (exportState === 'running' && Date.now() < deadline) {
        await wait(1000);
        exportState = ((await (await runnerFetch(`/projects/${projectId}/export/status`)).json()) as { state: string }).state;
      }
    }

    const ok = page.shared >= 6 && page.rootChildren > 0 && page.bridge === 'object' && health.ok && player && problems.length === 0 && (exportState === 'done' || exportState === 'skipped');
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify({ ...page, health: health.ok, player, export: exportState, problems, port: runnerPort })}`);
    if (projectId) await runnerFetch(`/projects/${projectId}`, { method: 'DELETE' });
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('SMOKE FAIL', err);
    app.exit(1);
  }
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // The editor runs on the runner's own address; it needs nothing from other sites except its web fonts.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (!details.url.startsWith(`http://${HOST}:${runnerPort}/`)) return callback({});
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ],
        },
      });
    });

    registerIpc();
    buildMenu();
    try {
      await startRunner();
    } catch (err) {
      await fatal(err);
      return;
    }
    mainWindow = createWindow(`http://${HOST}:${runnerPort}/`);
    if (SMOKE) void runSmokeTest(mainWindow);
  });

  app.on('before-quit', () => {
    quitting = true;
    killRunner();
  });
  app.on('window-all-closed', () => app.quit());
}
