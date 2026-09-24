import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './paths.js';

// One app-level log for everything the runner does. Each line is
//   <ISO time> <LEVEL> <event> key=value key=value ...
// so it is easy to read, grep and follow with `tail -f`. Project and marker ids are fields, so
// `grep project=my-project-1a2b3c` shows everything that happened to one project.

export { LOG_DIR };
export const LOG_FILE = path.join(LOG_DIR, 'runner.log');
const MAX_BYTES = 5 * 1024 * 1024;
const CONSOLE_LINE_MAX = 400;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

let bytesWritten = -1;

// Values of environment variables that look like secrets, plus anything shaped like an API key.
function redact(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) out = out.split(value).join('[redacted]');
  }
  return out.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
}

export function clip(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function rotateIfNeeded(): void {
  if (bytesWritten < 0) {
    bytesWritten = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  }
  if (bytesWritten >= MAX_BYTES) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    bytesWritten = 0;
  }
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`);
    const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);

    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
    bytesWritten += Buffer.byteLength(line) + 1;

    const consoleLine = line.length > CONSOLE_LINE_MAX ? `${line.slice(0, CONSOLE_LINE_MAX)}…` : line;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(consoleLine);
  } catch {
    // Logging must never break the request it is describing.
  }
}
