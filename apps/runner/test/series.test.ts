import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { createProject, addMarker } = await import('../src/lib/scaffold.ts');
const { projectDir, markerFile } = await import('../src/lib/paths.ts');
const { pickComponentName, parseProps, memberSource, sharedComponentFile } = await import('../src/lib/series.ts');
const { seriesDesign } = await import('../src/lib/planner.ts');
const { validateMarkerFile } = await import('../src/lib/validate.ts');

const project = createProject('Quiz', { baseLayer: { type: 'color', color: '#000000' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });

const proposal = (props: string) => ({ start: 0, end: 2, prompt: 'q', region: null, assets: [], narration: '', generateImage: false, props });
const question = (n: number) => JSON.stringify({ question: `Q${n}?`, answers: ['a', 'b'], correct: 0 });

test('a series needs a template and at least two markers that fill it in', () => {
  const component = { name: 'QuizCard', spec: 'A question card. Props: question, answers, correct.' };
  const planned = [proposal(''), proposal(question(1)), proposal(question(2))];
  assert.deepEqual(seriesDesign(project.id, { consistency: 'series', component }, planned), { consistency: 'series', component });
  assert.deepEqual(planned.map((p) => !!p.props), [false, true, true]);

  const alone = [proposal(question(1)), proposal('')];
  assert.deepEqual(seriesDesign(project.id, { consistency: 'series', component }, alone), { consistency: 'themed' });
  assert.ok(alone.every((p) => p.props === ''), 'props mean nothing outside a series');

  assert.deepEqual(seriesDesign(project.id, { consistency: 'series', component: null }, [proposal(question(1)), proposal(question(2))]), { consistency: 'themed' });
  assert.deepEqual(seriesDesign(project.id, { consistency: 'varied' }, [proposal('')]), { consistency: 'varied' });
  // Markers planned together should look like they belong together unless the plan says otherwise.
  assert.deepEqual(seriesDesign(project.id, {}, [proposal('')]), { consistency: 'themed' });
});

test("a template's name is PascalCase and never reuses an earlier plan's file", () => {
  assert.equal(pickComponentName(project.id, 'growth chart'), 'GrowthChart');
  assert.equal(pickComponentName(project.id, '3d bar-race'), 'DBarRace');
  assert.equal(pickComponentName(project.id, 42), 'SeriesCard');
  fs.mkdirSync(path.dirname(sharedComponentFile(project.id, 'GrowthChart')), { recursive: true });
  fs.writeFileSync(sharedComponentFile(project.id, 'GrowthChart'), '');
  assert.equal(pickComponentName(project.id, 'GrowthChart'), 'GrowthChart2');
});

test('template content must be a JSON object', () => {
  assert.equal(parseProps(''), null);
  assert.deepEqual(parseProps('{"year": 1990}'), { year: 1990 });
  assert.throws(() => parseProps('[1, 2]'));
  assert.throws(() => parseProps('{year: 1990}'));
});

test("a member's file renders the shared component with its own content and builds", async () => {
  const marker = addMarker(project.id, { start: 0, end: 2, prompt: 'Question 2', series: { component: 'QuizCard', props: { question: 'Is "this" `fine`? ${x}', answers: ['a'], correct: 0 } } });
  fs.mkdirSync(path.dirname(sharedComponentFile(project.id, 'QuizCard')), { recursive: true });
  fs.writeFileSync(
    sharedComponentFile(project.id, 'QuizCard'),
    "import React from 'react';\nexport default function QuizCard(p: { question: string; regionWidth: number; regionHeight: number }) {\n  return <div>{p.question}</div>;\n}\n"
  );
  fs.writeFileSync(markerFile(project.id, marker.marker_id), memberSource(marker.marker_id, marker.series!));
  const result = await validateMarkerFile(markerFile(project.id, marker.marker_id));
  assert.equal(result.ok, true, result.error);
  assert.ok(fs.existsSync(path.join(projectDir(project.id), '03_remotion_code', 'shared', 'QuizCard.tsx')));
});

test.after(cleanup);
