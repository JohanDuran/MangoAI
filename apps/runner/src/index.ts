import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { projectsRouter } from './routes/projects.js';
import { videoRouter } from './routes/video.js';
import { assetsRouter } from './routes/assets.js';
import { discoverSkills } from './lib/skills.js';
import { log, LOG_FILE } from './lib/log.js';

const app = express();
app.use(cors());
// express.json() only parses requests with an application/json content-type and calls
// next() immediately otherwise, so it's safe ahead of the multipart video upload route.
app.use(express.json());

// Media and static files are fetched constantly during playback; logging them would bury the rest.
const isNoisy = (method: string, url: string) =>
  url === '/health' ||
  (method === 'GET' && /^\/(sfx\/|skills\/[^/]+\/public\/|projects\/[^/]+\/(video|assets\/))/.test(url));

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

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(videoRouter);
app.use(assetsRouter);
app.use(projectsRouter);

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('error', 'http.unhandled', { method: req.method, path: req.originalUrl.split('?')[0], error: err });
  if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

process.on('uncaughtException', (err) => log('error', 'process.uncaughtException', { error: err.stack ?? err.message }));
process.on('unhandledRejection', (reason) => log('error', 'process.unhandledRejection', { error: reason }));

const PORT = Number(process.env.PORT) || 5175;
app.listen(PORT, () => {
  const { skills, problems } = discoverSkills();
  log('info', 'runner.start', {
    url: `http://localhost:${PORT}`,
    logFile: LOG_FILE,
    skills: skills.map((s) => `${s.name}${s.missingEnv.length ? `(missing ${s.missingEnv.join('+')})` : ''}`),
  });
  for (const p of problems) log('warn', 'skills.problem', { folder: p.folder, error: p.error });
});
