# cut.json: the MangoAI project format

The authoritative description of the project file (the sketch in DESIGN.md section 4 is older). Code:
`packages/core/src/schema.ts` (schema + validation), `time.ts` (expressions), `resolve.ts` (to numbers),
`ops.ts` (edits), `import/shortJson.ts` (short.json in and out).

One `cut.json` per project folder. It holds **only edit data**: no transcript words (they stay in
`words.tsv`), no waveforms, no thumbnails (those go in `.mangoai/`). That keeps a 50-minute edit with
2,000 clips well under a megabyte, and diffs readable.

## Top level

| Field | Meaning |
|---|---|
| `format`, `version` | `"mangoai/cut"`, `1` |
| `revision` | goes up by one on every save |
| `title` | optional |
| `width`, `height`, `fps` | output format (Shorts: 1080 × 1920, 30) |
| `transcripts` | name → `words.tsv` path. The first one is what `word:` terms read |
| `sources` | name → media path (relative to the project folder; `../../sfx_library/…` is fine) |
| `regions` | name → `[x, y, w, h]` crop on a recording |
| `blurs` | name → rectangle(s) to blur (privacy) |
| `anchors` | `[{ name, at }]`, named times, resolved top to bottom |
| `sections` | `[{ id, end, note? }]`, back to back (each starts where the previous ends): the shots of a Short, the chapters of a long video |
| `tracks` | see below; listed in **paint order**, first = bottom |
| `requests` | optional: what you pointed at in the editor and asked for (below) |
| `master` | optional `{ loudness, limiter }` (export aims for `loudness`, default −14 LUFS) |
| `extra` | fields kept from an import that MangoAI doesn't model yet (never lost) |

## Times

Every time is a number of seconds or an **expression** (same grammar as the toolbox's short.json):

| Term | Meaning |
|---|---|
| `1.5` | seconds |
| `word:so`, `word:use#2`, `word:so.end` | a word's start (or end), nth occurrence; case/punctuation ignored |
| `hook` | an anchor |
| `s01_hook.start`, `s01_hook.end` | a section's start/end |
| `words_end` | end of the last word |
| `timeline_end` | end of the last section (or of the latest clip when there are no sections) |
| `start`, `dur` | inside a clip's zoom `keys` only: the clip's start and length |

Terms are joined with ` + ` / ` - ` (spaces required): `"word:this#2 - 0.06"`, `"s03.end + 0.2"`.
Results are rounded to 4 decimals. A term that doesn't resolve becomes a *problem* on that clip; the rest of
the timeline still resolves.

## Tracks

```jsonc
{ "id": "A2", "kind": "audio", "role": "sfx", "name": "SFX", "gain": 0, "muted": false, "clips": [ … ] }
```

| `kind` | Clips allowed | Notes |
|---|---|---|
| `video` | `media`, `generator` | footage, stills, backdrops |
| `graphics` | `title`, `comp` | built-in titles and HyperFrames compositions |
| `captions` | none | draws from `transcript` with `style` (`y`, `max_words`, …); `enabled` |
| `audio` | `media` | `role`: `voice`, `sfx`, `music`, `other` |

## Clips

All clips: `id` (unique in the project), `type`, `start`, `end` (only audio may leave it out = to the end of
the media), optional `pivot`, `label`, `origin`, `extra`.

- **`pivot`**: seconds into the clip that land exactly on `start`. An SFX's loudest point (the toolbox's
  `peak`), so the hit is on the word. Resolved start = `start − pivot`.
- **`origin`**: where an imported clip came from (`"shot:3/layer:0"`, `"graphic:12"`, `"sfx:2/at:1"`), so it
  can be written back to short.json without loss.

| `type` | Fields |
|---|---|
| `media` | `src` (source name or path), `in`, `speed`, `speedTo: [from, to]`, `still`, `region`, `blur`, `cardW`, `cy`, `dim`, `keys: [[t, zoom, fx, fy], …]`, `gain` (dB), `fadeIn`/`fadeOut` (s), `loop`, `transcript` (its source's words: they follow this clip on the timeline) |
| `generator` | `generator`: `radial-gradient` / `color` / `image`, `params` |
| `title` | `style`, `pos`, `text` or `runs`, `fs`, `bold`, `color`, `box`, `strike`, `pop`, `fade`, `shape`, `layer` |
| `comp` | `comp` (HyperFrames folder), `vars` (values passed to the comp; a string starting with `@` is a time expression passed as seconds from the clip start, e.g. `"@word:hundred"`) |

## Words on the timeline

A media clip with `transcript: "<name>"` says its source's words are in `transcripts[name]` (in source time).
Those words are mapped through every such clip onto the timeline, and `word:` terms are looked up in the mapped
words of the first transcript. So cutting, moving or re-recording the voice moves everything linked to its words.
An imported Short's narration clip carries `transcript: "voice"`. With no such clip, the first transcript is taken
as timeline time.

## Requests

`{ id, kind: change | create, status: open | working | done | rejected, text, t?, clip?, element?: { selector, id,
text, box }, range?: [a, b], region?: [x, y, w, h] (0-1), assets?: [paths], still?: path, reply?, created }`

## Edits (ops)

Every change, by you or by Claude, is a list of ops applied as one undoable change:
`add_track`, `remove_track`, `update_track`, `add_clip`, `remove_clip`, `update_clip` (`set`, `null` removes a
field), `move_clip`, `split_clip`, `set_anchor`, `add_section`, `remove_section`, `update_section`, `set_title`, `set_transcript` (name, file or null),
`add_request`, `update_request`, `remove_request`. Editing commands built on them (move, trim, split, ripple,
cut ranges, link to a word…) are in `commands.ts` and shared by the editor and Claude's `edit` tool.
A change is all-or-nothing, records its exact inverse, and carries a one-line summary per op
("changed media s1: start → 2.3, gain → -6") for the history and for Claude.

## Importing a Short

`short.json` imports losslessly (all 35 existing Shorts verified, `npm run mango -- roundtrip <studio>`):

| short.json | cut.json |
|---|---|
| `backdrop` | V1 generator clip, `0 → timeline_end` |
| `shots[i]` | section `{ id: name, end, note }` |
| `shots[i].layers[j]` | media clip on V(j+2), `start: "<name>.start"`, `end: "<name>.end"` (`ss` → `in`, `card_w` → `cardW`, `speed_to` → `speedTo`) |
| `graphics[i]` | title clip on G1 (or one track per `layer` value) |
| `captions` | C1 captions track |
| `audio.narration` | A1 voice clip |
| `audio.sfx[i].at[j]` | one media clip per hit, `pivot: peak`; spread over A2, A3, … so none overlap when lengths are known |
| `audio.music`, `music_db` | A9 music clip, `loop`, `end: timeline_end`, `gain` |
| anything else | `extra`, written back as it was |
