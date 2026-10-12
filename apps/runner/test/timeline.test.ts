import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { createProject, addMarker } = await import('../src/lib/scaffold.ts');
const { deleteMarker } = await import('../src/lib/markers.ts');
const { readCompositionConfig } = await import('../src/lib/composition.ts');
const { fitTimeline } = await import('../src/lib/timeline.ts');
const { sequenceProposals, fitProposalsToLength } = await import('../src/lib/planner.ts');

const candidate = (start: number, end: number, prompt: string, overlapsOnPurpose = false) => ({
  start,
  end,
  prompt,
  region: null,
  assets: [],
  narration: '',
  generateImage: false,
  props: '',
  overlapsOnPurpose,
});
const times = (proposals: { start: number; end: number; prompt: string }[]) => proposals.map((p) => [p.prompt, p.start, p.end]);

test('overlapping plan markers are lined up one after another, keeping their length', () => {
  const { proposals, movedCount } = sequenceProposals([candidate(0, 4, 'a'), candidate(3, 6, 'b'), candidate(5, 9, 'c')], []);
  assert.deepEqual(times(proposals), [
    ['a', 0, 4],
    ['b', 4, 7],
    ['c', 7, 11],
  ]);
  assert.equal(movedCount, 2);
});

test('a marker in the way of an existing one moves after it, even past the end of the video', () => {
  const { proposals } = sequenceProposals([candidate(8, 10, 'late')], [{ start: 7, end: 10 }]);
  assert.deepEqual(times(proposals), [['late', 10, 12]]);
});

test('an overlap meant on purpose is kept, and moves along with the marker it joins', () => {
  const { proposals, movedCount } = sequenceProposals(
    [candidate(0, 4, 'scene'), candidate(2, 6, 'next scene'), candidate(3, 5, 'caption over next scene', true)],
    []
  );
  assert.deepEqual(times(proposals), [
    ['scene', 0, 4],
    ['next scene', 4, 8],
    ['caption over next scene', 5, 7],
  ]);
  assert.equal(movedCount, 2);
  const onPurposeOverExisting = sequenceProposals([candidate(1, 2, 'badge', true)], [{ start: 0, end: 5 }]);
  assert.deepEqual(times(onPurposeOverExisting.proposals), [['badge', 1, 2]]);
});

test('a project without a video grows to hold a marker past its end and never shrinks', () => {
  const p = createProject('No Video', { baseLayer: { type: 'color', color: '#000000' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });
  const m = addMarker(p.id, { start: 8, end: 12.5, prompt: 'runs over' });
  assert.equal(readCompositionConfig(p.id).durationInFrames, 375);
  deleteMarker(p.id, m.marker_id);
  assert.equal(readCompositionConfig(p.id).durationInFrames, 375, 'the length the project was given is not taken back');
});

test('an uploaded video keeps its length: markers do not stretch it', () => {
  const p = createProject('With Video', { baseLayer: { type: 'video' }, fps: 30, width: 320, height: 180, durationInFrames: 300 });
  addMarker(p.id, { start: 9, end: 14, prompt: 'runs over' });
  assert.equal(readCompositionConfig(p.id).durationInFrames, 300);
  assert.equal(fitTimeline(p.id).durationInFrames, 300);
});

test('planned markers that run past an uploaded video are compressed to end with it', () => {
  const fitted = fitProposalsToLength(
    [candidate(0, 4, 'a'), candidate(4, 8, 'b'), candidate(8, 12, 'c')].map(({ overlapsOnPurpose: _, ...p }) => p),
    10
  );
  assert.deepEqual(times(fitted), [
    ['a', 0, 3.33],
    ['b', 3.33, 6.67],
    ['c', 6.67, 10],
  ]);
  const inside = [candidate(1, 3, 'fits')].map(({ overlapsOnPurpose: _, ...p }) => p);
  assert.equal(fitProposalsToLength(inside, 10), inside, 'a plan that fits is left alone');
});

test.after(cleanup);
