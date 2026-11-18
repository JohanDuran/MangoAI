# mangoai

MangoAI is a local, multi-track video editor that Claude drives and you can touch: live preview, hand edits saved as
revisions Claude picks up, point-and-ask requests, HyperFrames graphics and an export that re-renders only what changed.

This package holds all of it: the editor server, the MCP server for Claude and the hook that reports your saves.

```bash
npx -y mangoai start      # the editor at http://localhost:4780
npx -y mangoai mcp        # MCP server for Claude (stdio); starts the editor server when needed
npx -y mangoai help
```

Needs Node 22+ and ffmpeg on PATH. Rendering uses HyperFrames (installed with this package).

## Part of video-studio

MangoAI is one of three pieces that work together:

| Piece | What it does |
|---|---|
| [video-studio](https://github.com/JohanDuran/video-studio) | The Claude Code plugin and the one place to start: skills, setup, and it registers the other two |
| [media-toolbox](https://github.com/JohanDuran/media-toolbox) | Local models in Docker: transcription, voices, sound effects, images |
| **MangoAI** (this package) | The editor: timeline, HyperFrames comps, render and export |

Install the video-studio plugin and run `/studio-setup`; it registers `mangoai mcp` and the hook for you. Only run
`mangoai setup` if you use MangoAI without the plugin (and then `npm i -g mangoai` first so the paths last).
