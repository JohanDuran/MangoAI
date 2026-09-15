import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';
import type { ValidationResult } from './validate.js';

export function logAttempt(
  id: string,
  markerId: string,
  attempt: number,
  code: string,
  validation: ValidationResult
): void {
  const dir = projectDir(id);
  const historyDir = path.join(dir, '05_debug', 'code_history');
  fs.mkdirSync(historyDir, { recursive: true });
  const stamp = Date.now();
  fs.writeFileSync(path.join(historyDir, `${markerId}-attempt${attempt}-${stamp}.tsx`), code);

  if (!validation.ok) {
    const logFile = path.join(dir, '05_debug', 'failed_attempts.log');
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ${markerId} attempt ${attempt}: ${validation.error}\n`
    );
  }
}
