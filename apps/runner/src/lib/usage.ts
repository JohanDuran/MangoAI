import { log } from './log.js';

// What Claude runs have cost since the runner started, taken from the CLI's own result events.
// Subscription plans are not billed per run, so this is an indication of usage, not an invoice.
const usage = { runs: 0, costUsd: 0, since: new Date().toISOString() };

export function recordClaudeRun(costUsd: unknown): void {
  usage.runs += 1;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) usage.costUsd += costUsd;
  log('debug', 'usage.claude', { runs: usage.runs, costUsd: Math.round(usage.costUsd * 1000) / 1000 });
}

export const getUsage = () => ({ ...usage, costUsd: Math.round(usage.costUsd * 1000) / 1000 });
