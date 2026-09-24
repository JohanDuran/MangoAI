import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { assertSafeId, projectDir, markerFile, InvalidIdError } = await import('../src/lib/paths.ts');
const { assetFilePath } = await import('../src/lib/images.ts');

test('ordinary project and marker ids are accepted', () => {
  for (const id of ['test-2fd79f', 'my_project-1', 'a', 'Investment-Over-Time-99a667']) assert.doesNotThrow(() => assertSafeId('project id', id));
  assert.doesNotThrow(() => markerFile('test-2fd79f', 'm12'));
});

test('ids that could leave the projects folder are rejected', () => {
  const bad = ['../x', '..', '.', 'a/b', 'a\\b', '', ' ', '.hidden', 'x'.repeat(200), 'a%2f..', 'C:\\Windows', 'a\u0000b'];
  for (const id of bad) assert.throws(() => projectDir(id), InvalidIdError, JSON.stringify(id));
  assert.throws(() => markerFile('ok-id', '../../secret'), InvalidIdError);
  assert.throws(() => assertSafeId('project id', undefined), InvalidIdError);
});

test('asset file names cannot contain paths', () => {
  assert.doesNotThrow(() => assetFilePath('test-2fd79f', 'up_1a2b3c4d.jpg'));
  for (const name of ['../../x.png', '..\\x.png', 'a/b.png', '.env', '']) assert.throws(() => assetFilePath('test-2fd79f', name), /Invalid asset file name/, JSON.stringify(name));
});

test.after(cleanup);
