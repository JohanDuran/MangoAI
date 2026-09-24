import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions, type SpawnOptionsWithoutStdio } from 'node:child_process';

// windowsHide stops a console window from flashing up for every ffmpeg/claude process when the
// runner is started by a GUI app.
export function spawnHidden(command: string, args: string[], options?: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
export function spawnHidden(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnHidden(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, { windowsHide: true, ...options });
}

// Ends a process and everything it started. On Windows a plain kill() only ends the direct child,
// which leaves ffmpeg or a Claude tool process running.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

// Runs a short-lived command and collects its output. Never rejects.
export function runCommand(command: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawnHidden(command, args, { cwd: opts.cwd });
    const done = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, timedOut });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.stderr?.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => done({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
