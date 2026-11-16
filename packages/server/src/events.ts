// Server-sent events to the open editor tabs, per project folder: Claude's saves, comp edits, transcript
// changes, frame requests, export progress. The editor never talks to Claude; this is one-way to the tab.
import type http from 'node:http';
import path from 'node:path';

interface Client {
  res: http.ServerResponse;
  id: string;
  since: number;
}

const clients = new Map<string, Set<Client>>();
const key = (dir: string) => path.resolve(dir).toLowerCase();

export function subscribe(dir: string, id: string, res: http.ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  const k = key(dir);
  const set = clients.get(k) ?? clients.set(k, new Set()).get(k)!;
  const c: Client = { res, id, since: Date.now() };
  set.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    set.delete(c);
  });
}

export function broadcast(dir: string, event: Record<string, unknown>) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients.get(key(dir)) ?? []) c.res.write(data);
}

/** Send to the most recently opened tab only (frame requests). */
export function sendToNewest(dir: string, event: Record<string, unknown>): boolean {
  const set = [...(clients.get(key(dir)) ?? [])].sort((a, b) => b.since - a.since);
  const c = set[0];
  if (!c) return false;
  c.res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}

export function connected(dir: string): number {
  return clients.get(key(dir))?.size ?? 0;
}
