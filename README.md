# MangoAI

A local, multi-track video editor that Claude drives and you can touch: live preview with no rendering,
separate video / graphics (HyperFrames) / captions / audio tracks, hand fixes saved as revisions Claude picks up,
point-and-ask requests, and an export that re-renders only what changed.

Status: phase 1 done (live viewer). Phase 0: project model. Read [docs/DESIGN.md](docs/DESIGN.md) and [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

## Run the editor

```bash
npm install
npm start
```

Open http://localhost:4780 and pick a project folder (one with a `cut.json` or `short.json`), or go straight to
`http://localhost:4780/?dir=<folder>`. Space plays, ←/→ step a frame (Shift: a second), Ctrl+wheel zooms the
timeline. Phase 1 only reads projects: a short.json is imported in memory and nothing is written except the
`.mangoai/` cache (probes, waveforms, proxies) inside the project folder.

## Command line

```bash
npm test
npm run mango -- info ../../../media-studio/jdkoder_shorts/Railway_AI_Keys
npm run mango -- import ../../../media-studio/jdkoder_shorts/Railway_AI_Keys --out railway.cut.json
npm run mango -- roundtrip ../../../media-studio
```

- `packages/web`: the editor (React + canvas): media pool, live viewer, multi-track timeline, inspector.
  `src/engine/` holds playback (audio clock, video sync, pre-roll) and the toolbox look (cards, titles, captions).
- `packages/server`: local server on 127.0.0.1 (opens folders, streams media with range requests, waveforms,
  proxies, viewer snapshots).
- `packages/core` is the project model: the `cut.json` schema, time expressions (word anchors), resolving to
numbers, undoable edit ops, and the lossless short.json importer/exporter.

Successor to the marker-based overlay app now called [CutRoomAI](https://github.com/JohanDuran/CutRoomAI).
