import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { classifyClaudeFailure } = await import('../src/lib/claude.ts');
const base = { exitCode: 1 };

test('a signed-out CLI is not retried and says what to do', () => {
  const f = classifyClaudeFailure({ ...base, text: 'Invalid API key · Please run /login' });
  assert.equal(f.kind, 'not-signed-in');
  assert.equal(f.retryable, false);
  assert.match(f.message, /sign in/);
});

test('usage limits are not retried', () => {
  for (const text of ['Claude AI usage limit reached|1700000000', 'Credit balance is too low', 'API Error: 429 rate_limit_error']) {
    const f = classifyClaudeFailure({ ...base, text });
    assert.equal(f.kind, 'usage-limit', text);
    assert.equal(f.retryable, false);
  }
});

test('transient network and overload errors are retried', () => {
  for (const text of ['API Error: 529 overloaded_error', 'read ECONNRESET', 'Service temporarily unavailable']) {
    const f = classifyClaudeFailure({ ...base, text });
    assert.equal(f.kind, 'overloaded', text);
    assert.equal(f.retryable, true);
  }
});

test('a missing executable is reported as not installed', () => {
  assert.equal(classifyClaudeFailure({ exitCode: null, text: '', spawnError: 'spawn claude ENOENT' }).kind, 'not-installed');
});

test('timeouts and cancellation win over whatever was printed', () => {
  assert.equal(classifyClaudeFailure({ ...base, text: 'Invalid API key', timedOut: true }).kind, 'timeout');
  const cancelled = classifyClaudeFailure({ ...base, text: 'anything', cancelled: true });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.retryable, false);
});

test('an old CLI that rejects a flag says to update', () => {
  const f = classifyClaudeFailure({ ...base, text: "error: unknown option '--setting-sources'" });
  assert.equal(f.kind, 'unsupported-cli');
  assert.match(f.message, /claude update/);
});

test('unknown failures keep the tail of the output for the user', () => {
  const f = classifyClaudeFailure({ exitCode: 3, text: 'line1\nline2\nsomething odd happened' });
  assert.equal(f.kind, 'failed');
  assert.match(f.message, /something odd happened/);
  assert.match(f.message, /exit code 3/);
});

test.after(cleanup);
