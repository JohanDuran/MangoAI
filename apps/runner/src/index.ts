import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { projectsRouter } from './routes/projects.js';
import { videoRouter } from './routes/video.js';
import { assetsRouter } from './routes/assets.js';
import { settingsRouter } from './routes/settings.js';
import { exportRouter, abortAllExports } from './routes/exportJob.js';
import { discoverSkills } from './lib/skills.js';
import { collectStatus } from './lib/status.js';
import { log, LOG_FILE } from './lib/log.js';
import { PACKAGED, EDITOR_DIST, InvalidIdError } from './lib/paths.js';
import { killAllClaude } from './lib/claude.js';
import { migrateProjects } from './lib/migrate.js';
import { cleanupLeftovers, trimRenderCache } from './lib/cleanup.js';
import { APP_VERSION } from './lib/version.js';

const app = express();
app.disable('x-powered-by');

// The runner is a local service for one person's machine. It only listens on the loopback address,
// and the checks below stop web pages the user happens to visit from talking to it: a browser sends
// its real Host and Origin headers, and a page on another site cannot forge either.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
let boundPort = 0;

const isOwnOrigin = (origin: string) => origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;

app.use((req, res, next) => {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    res.status(403).json({ error: 'Unexpected Host header' });
    return;
  }

  const origin = req.headers.origin;
  const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (origin) {
    // Reads are open to pages served from this machine (the Vite dev server, Remotion's render
    // page); anything that changes data must come from the app itself (or, in development, Vite).
    const allowed = isRead ? LOCAL_ORIGIN.test(origin) : PACKAGED ? isOwnOrigin(origin) : LOCAL_ORIGIN.test(origin);
    if (!allowed) {
      res.status(403).json({ error: 'Cross-origin request blocked' });
      return;
    }
    if (LOCAL_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// express.json() only parses requests with an application/json content-type and calls
// next() immediately otherwise, so it's safe ahead of the multipart video upload route.
app.use(express.json({ limit: '10mb' }));

// Media and static files are fetched constantly during playback; logging them would bury the rest.
const isNoisy = (method: string, url: string) =>
  url === '/health' ||
  (method === 'GET' && /^\/(sfx\/|skills\/[^/]+\/public\/|projects\/[^/]+\/(video|assets\/|overlay\.js)|assets\/)/.test(url));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('close', () => {
    const url = req.originalUrl.split('?')[0];
    // Reads that succeeded (the editor refreshes constantly) are skipped; changes and failures are kept.
    if (isNoisy(req.method, url) || (req.method === 'GET' && res.statusCode < 400)) return;
    log(res.statusCode >= 500 ? 'error' : 'info', 'http', {
      method: req.method,
      path: url,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get('/status', async (_req, res, next) => {
  try {
    res.json(await collectStatus());
  } catch (err) {
    next(err);
  }
});
app.use(settingsRouter);
app.use(videoRouter);
app.use(assetsRouter);
app.use(projectsRouter);
app.use(exportRouter);

// The installed app serves the built editor from here; in development Vite serves it instead.
if (fs.existsSync(path.join(EDITOR_DIST, 'index.html'))) {
  app.use(express.static(EDITOR_DIST));
}

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const bodyProblem = (err as { type?: string })?.type;
  const status = err instanceof InvalidIdError ? 400 : bodyProblem === 'entity.parse.failed' || bodyProblem === 'entity.too.large' ? 400 : 500;
  log(status >= 500 ? 'error' : 'warn', 'http.unhandled', { method: req.method, path: req.originalUrl.split('?')[0], status, error: err });
  if (!res.headersSent) res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
});

process.on('uncaughtException', (err) => log('error', 'process.uncaughtException', { error: err.stack ?? err.message }));
process.on('unhandledRejection', (reason) => log('error', 'process.unhandledRejection', { error: reason }));

const requestedPort = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 5175;
const host = process.env.MANGO_BIND || '127.0.0.1';

const server = app.listen(requestedPort, host, () => {
  boundPort = (server.address() as AddressInfo).port;
  // Generated code and skills are told this address, so it has to match the real port.
  process.env.PORT = String(boundPort);
  process.env.MANGO_HOST ??= host === '127.0.0.1' ? '127.0.0.1' : 'localhost';

  migrateProjects();
  cleanupLeftovers();
  trimRenderCache();

  const { skills, problems } = discoverSkills();
  log('info', 'runner.start', {
    version: APP_VERSION,
    url: `http://${process.env.MANGO_HOST}:${boundPort}`,
    logFile: LOG_FILE,
    packaged: PACKAGED,
    skills: skills.map((s) => `${s.name}${s.missingEnv.length ? `(missing ${s.missingEnv.join('+')})` : ''}`),
  });
  for (const p of problems) log('warn', 'skills.problem', { folder: p.folder, error: p.error });
  // The desktop app starts the runner with an IPC channel and waits for this message.
  process.send?.({ type: 'ready', port: boundPort });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  log('error', 'runner.listen_failed', { port: requestedPort, code: err.code, error: err.message });
  process.send?.({ type: 'error', code: err.code, message: err.message });
  process.exit(1);
});

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'runner.stop', { reason });
  killAllClaude();
  abortAllExports();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// When the desktop app that started the runner goes away, so does the runner.
process.on('disconnect', () => shutdown('parent disconnected'));
process.on('message', (m) => {
  if ((m as { type?: string })?.type === 'shutdown') shutdown('requested');
});
