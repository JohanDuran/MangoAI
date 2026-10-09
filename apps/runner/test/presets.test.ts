import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempData } from './helpers.ts';

const { cleanup } = useTempData();
const { createProject, addMarker, updateProjectSettings, listProjects } = await import('../src/lib/scaffold.ts');
const { updateMarkerStatus, updateMarkerRegion } = await import('../src/lib/markers.ts');
const { markerFile } = await import('../src/lib/paths.ts');
const { savePreset, listPresets, readPreset, deletePreset } = await import('../src/lib/presets.ts');
const { buildRegeneratePrompt } = await import('../src/lib/claude.ts');

const source = createProject('Brand Video', { baseLayer: { type: 'transparent' }, fps: 30, width: 640, height: 360, durationInFrames: 300 });
const region = { x: 0.6, y: 0.05, width: 0.35, height: 0.3 };

test('only a generated marker can become a style, and the style keeps its code and area', () => {
  const m = addMarker(source.id, { start: 0, end: 2, prompt: 'lower third', region });
  assert.throws(() => savePreset(source.id, m.marker_id, 'Navy cards'), /Generate it first/);
  fs.writeFileSync(markerFile(source.id, m.marker_id), 'export default () => <div style={{ background: "#0b1f3a" }} />;\n');
  updateMarkerStatus(source.id, m.marker_id, '', 'ready');
  assert.throws(() => savePreset(source.id, m.marker_id, '   '), /name/);

  const saved = savePreset(source.id, m.marker_id, 'Navy cards');
  assert.equal(saved.fromProject, 'Brand Video');
  assert.deepEqual(saved.region, region);
  assert.equal('code' in saved, false, 'listings do not carry the code');
  assert.match(readPreset(saved.id)!.code, /#0b1f3a/);
  assert.deepEqual(listPresets().map((p) => p.name), ['Navy cards']);
  assert.equal(listProjects().length, 1, 'the presets folder is not mistaken for a project');
});

test("a project's style is given to its new markers and reaches the prompt as a reference", () => {
  const preset = listPresets()[0];
  const other = createProject('Next Video', { baseLayer: { type: 'transparent' }, fps: 30, width: 640, height: 360, durationInFrames: 300 });
  assert.equal(addMarker(other.id, { start: 0, end: 1, prompt: 'a' }).stylePreset, undefined);
  updateProjectSettings(other.id, { stylePreset: preset.id });
  const styled = addMarker(other.id, { start: 2, end: 3, prompt: 'b' });
  assert.equal(styled.stylePreset, preset.id);

  // The style's area can be applied (the route does this through updateMarkerRegion).
  assert.deepEqual(updateMarkerRegion(other.id, styled.marker_id, readPreset(preset.id)!.region ?? null).region, region);

  const prompt = buildRegeneratePrompt({
    markerId: styled.marker_id,
    currentCode: '',
    prompt: 'b',
    feedback: '',
    styleReference: { name: preset.name, code: readPreset(preset.id)!.code },
    compositionWidth: 640,
    compositionHeight: 360,
    regionWidth: 224,
    regionHeight: 108,
    isFullScreen: false,
  });
  assert.match(prompt, /Match the visual style of the "Navy cards" style/);
  assert.match(prompt, /#0b1f3a/);
  assert.match(prompt, /Do not copy its content/);
});

test('deleting a style removes it from the list', () => {
  const preset = listPresets()[0];
  assert.equal(deletePreset(preset.id), true);
  assert.equal(readPreset(preset.id), null);
  assert.deepEqual(listPresets(), []);
  assert.equal(deletePreset('../../etc'), false);
});

test.after(cleanup);
