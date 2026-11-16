# MangoAI

A local, multi-track video editor that Claude drives and you can touch: live preview with no rendering,
separate video / graphics (HyperFrames) / captions / audio tracks, hand fixes saved as revisions Claude picks up,
point-and-ask requests, and an export that re-renders only what changed.

Status: phases 0–7 built (see the roadmap in [docs/DESIGN.md](docs/DESIGN.md) for what each covers and what's left).
The file format is in [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

## Run the editor

```bash
npm install
npm start
```

Open http://localhost:4780 and pick a project folder (one with a `cut.json` or `short.json`), or go straight to
`http://localhost:4780/?dir=<folder>`. A short.json is imported; the first Save writes `cut.json` next to it
(short.json is never changed). Everything else MangoAI keeps goes in the project's `.mangoai/` folder
(cache, revisions, history, drafts, comp versions) and exports go to `renders/`.

| Keys | |
|---|---|
| Space · ← → (Shift: 1 s) · Home / End | play, step a frame, jump |
| drag a clip · drag its edge · Alt | move (also to another track) · trim · no snapping |
| S · Del · Shift+Del | split at the playhead · delete · ripple delete (or cut the I/O range on every track) |
| , . (Shift: 10 frames) | nudge |
| Ctrl+C / V / D | copy, paste at the playhead, duplicate |
| I / O · Shift-drag the ruler · X | set the range · clear it |
| M | marker at the playhead (drag it on the ruler) |
| R | request mode: click a graphic, or drag a box, then describe what you want |
| Ctrl+Z / Ctrl+Shift+Z · Ctrl+S | undo / redo · save (a new revision Claude will see) |

Snapping a clip's start onto a word, marker or section links it there (it follows if the voice changes).

## With Claude

`packages/mcp` is an MCP server with the editor's tools (state, selection, frame, edit, apply_ops, requests,
comp_create / comp_versions / comp_stills, transcript, export, export_otio …), and `packages/mcp/hook.mjs` tells
Claude on your next message what you saved since it last looked. To register both with Claude Code (user scope):

```bash
npm run claude-setup
```

prints what it would change; add `-- --yes` to do it. The MCP server starts the MangoAI server by itself when
needed.

## Command line

```bash
npm test
npm run typecheck
npm run mango -- info ../../../media-studio/jdkoder_shorts/Railway_AI_Keys
npm run mango -- roundtrip ../../../media-studio
```

- `packages/core`: the project model: `cut.json` schema, time expressions (word anchors, words mapped through
  clips), resolving to numbers, undoable ops, editing commands (move, trim, split, ripple, cut ranges, link),
  transcript cuts, and the lossless short.json importer/exporter.
- `packages/web`: the editor (React + canvas): media pool, live viewer with HyperFrames comps, timeline, inspector,
  requests, transcript, history, export.
- `packages/server`: local server on 127.0.0.1: projects, saves and revisions, live events to the editor, media,
  waveforms, proxies, comp pages and versions, cached export, OTIO.
- `packages/mcp`: Claude's tools and the hook.

Successor to the marker-based overlay app now called [CutRoomAI](https://github.com/JohanDuran/CutRoomAI).
