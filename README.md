# MangoAI

A local, multi-track video editor that Claude drives and you can touch: live preview with no rendering,
separate video / graphics (HyperFrames) / captions / audio tracks, hand fixes saved as revisions Claude picks up,
point-and-ask requests, and an export that re-renders only what changed.

Status: phase 0 done (project model). Read [docs/DESIGN.md](docs/DESIGN.md) and [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

## Try it

```bash
npm install
npm test
npm run mango -- info ../../../media-studio/jdkoder_shorts/Railway_AI_Keys
npm run mango -- import ../../../media-studio/jdkoder_shorts/Railway_AI_Keys --out railway.cut.json
npm run mango -- roundtrip ../../../media-studio
```

`packages/core` is the project model: the `cut.json` schema, time expressions (word anchors), resolving to
numbers, undoable edit ops, and the lossless short.json importer/exporter.

Successor to the marker-based overlay app now called [CutRoomAI](https://github.com/JohanDuran/CutRoomAI).
