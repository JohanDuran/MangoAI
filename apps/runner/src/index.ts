import express from 'express';
import cors from 'cors';
import { projectsRouter } from './routes/projects.js';
import { videoRouter } from './routes/video.js';

const app = express();
app.use(cors());
// express.json() only parses requests with an application/json content-type and calls
// next() immediately otherwise, so it's safe ahead of the multipart video upload route.
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(videoRouter);
app.use(projectsRouter);

const PORT = Number(process.env.PORT) || 5175;
app.listen(PORT, () => {
  console.log(`MangoAI runner listening on http://localhost:${PORT}`);
});
