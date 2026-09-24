import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';

// The packaged app points these at the ffmpeg build it ships; in development they fall back to PATH.
export const ffmpegBin = (): string => process.env.MANGO_FFMPEG || 'ffmpeg';
export const ffprobeBin = (): string => process.env.MANGO_FFPROBE || 'ffprobe';

export interface ClaudeBinary {
  command: string;
  // .cmd/.bat shims (npm installs) cannot be started without a shell on Windows.
  viaShell: boolean;
}

function searchDirs(): string[] {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  // A GUI app started from the Start menu can have a shorter PATH than a terminal, so the usual
  // install locations are checked as well.
  const known = isWin
    ? [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'claude')]
    : [path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin')];
  return [...dirs, ...known];
}

// Locates the Claude Code CLI. Returns null when it is not installed. Not cached: the user may
// install it while the app is open, and a few file checks are cheap next to a Claude run.
export function findClaude(): ClaudeBinary | null {
  const override = process.env.MANGO_CLAUDE_PATH;
  if (override && fs.existsSync(override)) return { command: override, viaShell: /\.(cmd|bat)$/i.test(override) };

  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of searchDirs()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return { command: candidate, viaShell: /\.(cmd|bat)$/i.test(name) };
      } catch {
        // not here
      }
    }
  }
  return null;
}

// Quotes one argument for cmd.exe (only needed when a .cmd shim is started through a shell).
export function quoteForCmd(arg: string): string {
  if (/^[\w@%+=:,./\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}
