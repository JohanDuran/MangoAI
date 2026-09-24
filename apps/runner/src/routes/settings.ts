import { Router } from 'express';
import { log } from '../lib/log.js';

export const settingsRouter = Router();

// The desktop app keeps the OpenAI key in the operating system's encrypted storage and hands it to the
// runner here, so it never has to be written into a file the user edits.
settingsRouter.put('/settings/openai-key', (req, res) => {
  const key = (req.body as { key?: unknown }).key;
  if (key === null || key === '') {
    delete process.env.OPENAI_API_KEY;
    log('info', 'settings.openai_key', { set: false });
    return res.json({ set: false });
  }
  if (typeof key !== 'string' || key.length < 8 || key.length > 400 || /\s/.test(key)) {
    return res.status(400).json({ error: 'That does not look like an API key.' });
  }
  process.env.OPENAI_API_KEY = key;
  log('info', 'settings.openai_key', { set: true });
  res.json({ set: true });
});
