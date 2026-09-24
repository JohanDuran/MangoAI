import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempData } from './helpers.ts';

const { root, cleanup } = useTempData();
const { createProject, addMarker, readProject, listProjects, CURRENT_SCHEMA_VERSION } = await import('../src/lib/scaffold.ts');
const { readMarkers } = await import('../src/lib/markers.ts');
const { markerFrameRanges, perMarkerFrameRanges } = await import('../src/lib/ranges.ts');
const { migrateProjects } = await import('../src/lib/migrate.ts');
const { cleanupLeftovers } = await import('../src/lib/cleanup.ts');

const project = createProject('Range Test', { baseLayer: { type: 'transparent' }, fps: 30, width: 640, height: 360, durationInFrames: 900 });

test('new projects carry the current schema version', () => {
  assert.equal(readProject(project.id)?.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('markers close together are merged into one render range, distant ones are not', () => {
  addMarker(project.id, { start: 1, end: 3, prompt: 'a' });
  addMarker(project.id, { start: 4, end: 6, prompt: 'b' }); // 1 s gap: merged with the default 2 s tolerance
  addMarker(project.id, { start: 20, end: 22, prompt: 'c' });
  assert.deepEqual(markerFrameRanges(project.id), [{ from: 30, to: 179 }, { from: 600, to: 659 }]);
  assert.equal(markerFrameRanges(project.id, 0).length, 3);
  assert.equal(perMarkerFrameRanges(project.id).length, 3);
});

test('marker ids count up', () => {
  assert.deepEqual(readMarkers(project.id).map((m) => m.marker_id), ['m1', 'm2', 'm3']);
});

test('a project from before versioning is upgraded on start', () => {
  const file = path.join(root, 'projects', project.id, 'project.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete old.schemaVersion;
  fs.writeFileSync(file, JSON.stringify(old));
  migrateProjects();
  assert.equal(readProject(project.id)?.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('a corrupted markers file is recovered from its backup', () => {
  const file = path.join(root, 'projects', project.id, '00_input', 'markers.json');
  assert.ok(fs.existsSync(`${file}.bak`));
  fs.writeFileSync(file, '[{"marker_id": "m1", "sta');
  assert.equal(readMarkers(project.id).length, 2); // the state before the most recent write
});

test('leftovers of an interrupted run are cleaned up, real files are not', () => {
  const dir = path.join(root, 'projects', project.id);
  const stale = [
    path.join(dir, '00_input', 'upload_ab12cd34.part'),
    path.join(dir, '01_transcript', 'audio.mp3'),
    path.join(dir, '04_output', 'overlay.webm.tmp.webm'),
    path.join(dir, '00_input', 'markers.json.123.abcdef.tmp'),
  ];
  const keep = [path.join(dir, '00_input', 'markers.json'), path.join(dir, '04_output', 'overlay.webm')];
  for (const f of [...stale, ...keep]) fs.writeFileSync(f, 'x');
  cleanupLeftovers();
  for (const f of stale) assert.equal(fs.existsSync(f), false, f);
  for (const f of keep) assert.equal(fs.existsSync(f), true, f);
});

test('project listing ignores folders with unsafe names', () => {
  fs.mkdirSync(path.join(root, 'projects', 'not a valid id!'));
  assert.deepEqual(listProjects().map((p) => p.id), [project.id]);
});

test.after(cleanup);
