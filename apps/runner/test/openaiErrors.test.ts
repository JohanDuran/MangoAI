import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { explainOpenAIError } = await import('../src/lib/transcript.ts');

test('OpenAI errors become actionable messages', () => {
  assert.match(explainOpenAIError(401, '{"error":{"message":"Incorrect API key provided"}}'), /rejected your API key/);
  assert.match(explainOpenAIError(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}'), /out of credit/);
  assert.match(explainOpenAIError(429, '{"error":{"message":"Rate limit reached for requests"}}'), /rate limiting/);
  assert.match(explainOpenAIError(503, ''), /having problems/);
  assert.match(explainOpenAIError(400, '{"error":{"message":"Invalid file format"}}'), /Invalid file format/);
  assert.match(explainOpenAIError(500, 'not json at all'), /having problems/);
});

test.after(cleanup);
