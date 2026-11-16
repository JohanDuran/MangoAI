#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: when you've saved edits in MangoAI (or left requests) since Claude last
// looked, tell Claude on your next message. Fast and quiet: reads a few small files, prints nothing when
// there's nothing new. Registered by `npm run mango -- install-claude` (or by hand, see README).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

let input = '';
try {
  input = fs.readFileSync(0, 'utf-8');
} catch {}
void input;

const registry = read(path.join(os.homedir(), '.mangoai', 'projects.json')) ?? [];
const notes = [];
for (const { dir, opened } of registry.slice(0, 10)) {
  if (!dir || Date.now() - Date.parse(opened) > 3 * DAY) continue;
  const cut = read(path.join(dir, 'cut.json'));
  if (!cut) continue;
  const metaFile = path.join(dir, '.mangoai', 'claude.json');
  const meta = read(metaFile) ?? {};
  const seen = meta.seen ?? 0;
  const seenReq = new Set(meta.requests ?? []);
  const lines = [];
  if (cut.revision > seen) {
    let hist = [];
    try {
      hist = fs
        .readFileSync(path.join(dir, '.mangoai', 'history.jsonl'), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.rev > seen && l.author !== 'claude');
    } catch {}
    for (const h of hist.slice(-8)) {
      const sum = (h.summary ?? []).slice(0, 8).join('; ');
      lines.push(`  rev ${h.rev}, saved by you: ${sum}${(h.summary ?? []).length > 8 ? ` (+${h.summary.length - 8} more)` : ''}`);
    }
    if (!hist.length) lines.push(`  now at revision ${cut.revision} (you last saw ${seen}); cut.json was changed`);
  }
  const fresh = (cut.requests ?? []).filter((r) => r.status === 'open' && !seenReq.has(r.id));
  if (fresh.length) lines.push(`  ${fresh.length} new request${fresh.length > 1 ? 's' : ''}: ${fresh.map((r) => `${r.id} "${String(r.text).slice(0, 80)}"`).join('; ')}`);
  if (!lines.length) continue;
  notes.push(`MangoAI project ${dir} (revision ${cut.revision}):\n${lines.join('\n')}`);
  try {
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, seen: cut.revision, requests: [...seenReq, ...fresh.map((r) => r.id)], at: new Date().toISOString() }, null, 1));
  } catch {}
}

if (notes.length) {
  const context = `${notes.join('\n\n')}\n(Use the mangoai tools: project_state / changes_since / requests_list. Edits you make need base = the current revision.)`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
}
process.exit(0);
