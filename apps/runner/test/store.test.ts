import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempData } from './helpers.ts';

const { root, cleanup } = useTempData();
const { writeJsonAtomic, readJson, writeFileAtomic } = await import('../src/lib/store.ts');

test('writes leave no temp files and keep the previous version as .bak', () => {
  const file = path.join(root, 'a.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(readJson(file), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')), { v: 1 });
  assert.equal(fs.readdirSync(root).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('a truncated file is recovered from the backup', () => {
  const file = path.join(root, 'b.json');
  writeJsonAtomic(file, { keep: 'me' });
  writeJsonAtomic(file, { keep: 'me too' });
  fs.writeFileSync(file, '{"keep": "me t'); // what a crash in the middle of a plain write leaves behind
  assert.deepEqual(readJson(file), { keep: 'me' });
  // and the file itself is repaired
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { keep: 'me' });
});

test('an unreadable file with no backup reports a clear error', () => {
  const file = path.join(root, 'c.json');
  fs.writeFileSync(file, '{oops');
  assert.throws(() => readJson(file), /c\.json is unreadable and no valid backup exists/);
});

test('writeFileAtomic replaces content completely', () => {
  const file = path.join(root, 'd.txt');
  writeFileAtomic(file, 'first version, quite long');
  writeFileAtomic(file, 'short');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'short');
});

test.after(cleanup);
