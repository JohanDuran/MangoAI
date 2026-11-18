# MangoAI

> **Part of [video-studio](https://github.com/JohanDuran/video-studio).** Three repos work together: the video-studio
> plugin (the place to start), the [media-toolbox](https://github.com/JohanDuran/media-toolbox) and
> [MangoAI](https://github.com/JohanDuran/MangoAI). To use them, install the plugin and run `/studio-setup`; Claude
> sets up the rest. Changes here can affect the other two: see [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md).

A local, multi-track video editor that Claude drives and you can touch: live preview with no rendering,
separate video / graphics (HyperFrames) / captions / audio tracks, hand fixes saved as revisions Claude picks up,
point-and-ask requests, and an export that re-renders only what changed.

Status: phases 0–7 built (see the roadmap in [docs/DESIGN.md](docs/DESIGN.md) for what each covers and what's left).
The file format is in [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md).

## Run the editor

With the video-studio plugin nothing is needed: any MangoAI tool starts the editor. Without it:

```bash
npx -y mangoai start
```

From a clone (development):

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

## The media toolbox

MangoAI edits and renders; the [media toolbox](https://github.com/JohanDuran/media-toolbox) (Docker, GPU) runs the
models. The **Toolbox** tab calls it at `http://127.0.0.1:8765` (override with `MANGO_TOOLBOX_URL`):

- **Sounds**: search the shared sound library, or generate new ones with Stable Audio; listen, drag onto the
  timeline or add at the playhead (the library records which project used it).
- **Voice a line**: Kokoro, or a cloned voice from `media-studio/voices` (Chatterbox); the WAV goes in
  `audio/lines/` and onto a voice track.
- **Transcribe**: WhisperX for any recording on the timeline without words; the transcript goes in `transcripts/`
  and its words follow those clips (one undoable change).

Without Docker the tab says so and everything else keeps working.

## With Claude

`packages/mcp` is an MCP server with the editor's tools (state, selection, frame, edit, apply_ops, requests,
comp_create / comp_versions / comp_stills, comp_render (any HyperFrames folder to MP4/MOV: the studio's only HyperFrames renderer), transcript, export, export_otio …), and `packages/mcp/hook.mjs` tells
Claude on your next message what you saved since it last looked.

**With the video-studio plugin** both are registered for you (the plugin runs the pinned `mangoai` package). If you
develop MangoAI, point the plugin at your clone instead of registering it a second time:
`[Environment]::SetEnvironmentVariable('MANGOAI_REPO', '<this folder>', 'User')`, then restart Claude.

**Without the plugin**, register both with Claude Code (user scope): `npm run claude-setup` from a clone (or
`mangoai setup` after `npm i -g mangoai`) prints what it would change; add `--yes` (`-- --yes` with npm) to do it.
The MCP server starts the MangoAI server by itself when needed.

## Command line

```bash
npm test
npm run typecheck
npm run mango -- info <project folder>
npm run mango -- roundtrip <studio folder>
npm run build       # the publishable `mangoai` package in packages/cli/dist
```

- `packages/core`: the project model: `cut.json` schema, time expressions (word anchors, words mapped through
  clips), resolving to numbers, undoable ops, editing commands (move, trim, split, ripple, cut ranges, link),
  transcript cuts, and the lossless short.json importer/exporter.
- `packages/web`: the editor (React + canvas): media pool, live viewer with HyperFrames comps, timeline, inspector,
  requests, transcript, history, export.
- `packages/server`: local server on 127.0.0.1: projects, saves and revisions, live events to the editor, media,
  waveforms, proxies, comp pages and versions, cached export, OTIO.
- `packages/mcp`: Claude's tools and the hook.
- `packages/cli`: the published `mangoai` package (one `mangoai` command; bundles the others, prebuilt editor).

Releases: bump `packages/core/src/version.ts` and `packages/cli/package.json`, push tag `vX.Y.Z`; the `release`
workflow attaches `mangoai-X.Y.Z.tgz` to the GitHub release (and publishes to npm when `NPM_TOKEN` is set). Then
bump the pin in video-studio (see [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md)).

Successor to the marker-based overlay app now called [CutRoomAI](https://github.com/JohanDuran/CutRoomAI).
