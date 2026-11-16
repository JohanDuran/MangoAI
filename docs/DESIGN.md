# MangoAI: design draft

> A local, multi-track video editor that Claude drives and you can touch. The goal is one thing:
> **make each video faster to create, especially the 5th and 15th small change.**

Status: draft for discussion (2026-11-15). Nothing built yet.

---

## 1. The problem, in numbers from a real project

`jdkoder_shorts/Railway_AI_Keys` (48.6 s Short) is built like this today:

```
script.json → speak_clone (10 lines) → narration.wav → WhisperX → words.tsv (fixed by hand)
          → ONE HyperFrames comp (48.6 s, GSAP times hard-coded to the words) → edit/main.mp4
          → short.json (6 shots cut out of main.mp4, captions, music, 5 SFX lists) → short_build → preview.mp4
          → alimiter → renders/final.mp4
```

Why a small change is expensive:

| Change you ask for | What has to re-run today |
|---|---|
| Move one SFX by 0.2 s | whole short_build (all video re-encoded) |
| Bigger title in scene 3 | whole 48.6 s HyperFrames render + short_build |
| Re-voice one line | voice → transcribe → **hand re-timing of GSAP cues** → full HF render → short_build |
| "Let me just see it" | a render. There is no live preview of the *assembled* edit |

Three root causes:
1. **No live preview of the whole edit.** You only see the edit as a rendered file.
2. **Everything is one block.** One comp for the whole video, one render for the whole Short. Nothing is cached.
3. **Timing is baked in.** Cues are numbers in code, not links to words, so a new take breaks them.

MangoAI fixes all three: live preview (no render), per-clip cached export, and timing anchored to words/markers.

---

## 2. Review: how real editors work, and what we take

### 2.1 The shared model (Premiere, Resolve, Final Cut, Kdenlive, Shotcut)
Every serious NLE has the same core, and so will we:

- **Media pool / bins.** Source files are *referenced*, never modified. Each has probed metadata, a thumbnail
  strip and a waveform. → Our media pool **is the project folder**, watched live.
- **Timeline = tracks of clips.** A clip is `(media, source in/out, timeline start)`. Gaps are empty space.
  Video tracks stack (V2 paints over V1); audio tracks mix (sum). → Same.
- **Non-destructive edit decision list.** The timeline is data; the pixels are only made at render. → Same, as a
  JSON file Claude can read and patch.
- **Edit tools**: select, blade (split), ripple delete, trim (ripple / roll / slip / slide), snapping, linked
  A/V clips, markers, undo/redo. → Same set; this is what makes manual fixes fast.
- **Proxies / optimized media** (Resolve, Premiere): small, easy-to-seek copies for editing, originals for export.
  → Same; essential for 30-min recordings.
- **Render cache** (Resolve Smart Cache, Premiere's red/yellow/green bar over the timeline): pieces that are
  expensive are pre-rendered once and reused until they change. → **This is the heart of fast export.** We show
  the same bar.
- **Compound / nested clips** (Resolve compound clips, Premiere nested sequences): a whole sub-timeline acts as
  one clip. → This is exactly how a HyperFrames composition fits in (see 3.3).

### 2.2 MLT (engine under Kdenlive and Shotcut)
MLT's model is the clearest open-source reference: **Producer** (anything that makes frames: a file, a colour,
a title), **Playlist** (one track: clips and blanks in order), **Tractor + Multitrack** (tracks stacked),
**Transition** (how track N combines with track N-1: composite, mix), **Filter** (effects on a clip/track),
**Consumer** (preview window or file encoder). Same graph for preview and export.
→ We take the idea that **preview and export are two consumers of one timeline**, so they can't disagree.

### 2.3 Final Cut Pro: magnetic timeline
A primary storyline plus clips *connected* to a point in it; move the main clip and its connected titles/SFX
move with it. → We take this as **anchors**: an SFX or graphic can be anchored to a clip, a marker or a
**transcript word**. Re-voice a line, the word moves, everything anchored to it moves. This kills root cause 3.

### 2.4 Descript: text-based editing
Delete words in the transcript and the media is cut. → We take a **transcript panel** synced to the timeline:
click a word to seek, select words to cut/split, words as snap points. Huge for long-form recordings.

### 2.5 Olive: cache by hash
Olive caches rendered frames keyed by a hash of everything that produced them, so unchanged parts never
re-render. → We cache per clip (not per frame): hash of inputs → rendered file.

### 2.6 OpenTimelineIO (Academy Software Foundation)
The interchange standard: Timeline → Stack → Tracks → Clips / Gaps / Transitions, with media references and
rational time. Resolve (18.5+) and Premiere import/export it; Kdenlive does too (with a known track-order flip
into Resolve). → Our data model is **OTIO-shaped**, so "finish in Resolve" is one export away.

### 2.7 Browser editors (OpenCut, Diffusion Studio, Remotion's editor starter)
OpenCut (open-source CapCut-style, browser) proves a web timeline with Canvas + Web Audio works; it is being
rewritten (plugin-first, Rust core, planned MCP/headless API), so it isn't something to build on today.
The modern stack for frame-accurate browser preview is **WebCodecs** decoding, via **Mediabunny** (TypeScript,
reads MP4/WebM, gives you "the frame at time t"). Seeking cost depends on keyframe spacing, which is why
proxies use short GOPs.

### 2.8 HyperFrames Studio (already on your PC)
`npx hyperframes preview` is a timeline editor *for one composition*, hot-reloads, and exposes the user's
selection to agents (`preview --context --json`: element id, time, bounding box). It also ships an embeddable
`<hyperframes-player>`. → We **embed** the player for graphics clips, and copy the selection-to-agent idea for
comments. Studio stays useful for deep animation work inside one comp; MangoAI is the edit around it.

---

## 3. What MangoAI is

### 3.1 Shape
- A **separate app**: own repo (`~/Documents/Projects/MangoAI`), own process. Not part of media-toolbox.
- **Local web app**: a Node server on `localhost` + a browser UI (Chrome/Edge: needs WebCodecs). Can be wrapped
  in Electron later if you want a desktop window; nothing in the design depends on it.
- **Opens a folder** (a project folder like `jdkoder_shorts/Railway_AI_Keys`). Everything it writes goes into
  that folder: the timeline file, comments, and a `.mangoai/` cache (proxies, waveforms, renders). Raw
  recordings are only read, never written (house rule).
- **Ships its own MCP server**, so Claude in the chat drives the same open project you see.
- Free tools only: ffmpeg, HyperFrames local render, Mediabunny, Web Audio. Optional: calls media-toolbox for
  TTS/transcribe/SFX (see decision D4).

### 3.2 Screen layout (classic NLE)
```
┌─────────────┬───────────────────────────────┬──────────────────┐
│ Media pool  │          Viewer               │ Inspector        │
│ (folder,    │   (live composite, safe       │ (selected clip:  │
│  live)      │    zones, comment pins)       │  in/out, gain,   │
│ Transcript  │   ◀ ▶ ▮▮  00:12.40 / 00:48.60 │  position, props)│
├─────────────┴───────────────────────────────┴──────────────────┤
│ Cache bar  ███████████▒▒▒▒████████  (green = rendered, grey=stale)
│ Ruler/markers ▼hook      ▼attack           ▼rules              │
│ C1 Captions │ [Hackers] [stole] [keys]  ...                    │
│ G2 Graphics │      [lower-third]          [3 rules card]       │
│ G1 Graphics │ [s01_hook][ s02_attack  ][s03][s04][ s05_rules ] │
│ V1 Video    │ [screen_rec.mp4 ............................]    │
│ A1 Voice    │ ~~~~~~~ narration.wav ~~~~~~~~~~~~~~~~~~~~~~~~   │
│ A2 SFX      │  ▪whoosh  ▪pop    ▪thud  ▪pop  ▪ding             │
│ A3 SFX      │       ▪counter                                   │
│ A4 Music    │ ═══════ dark-minimal bed (ducked) ═══════════    │
└──────────────────────────────────────────────────────────────────┘
```
Each track: name, lock, mute/solo (audio), hide (video), height. Audio clips show waveforms and a gain line
you can drag; audio tracks get a level meter.

### 3.3 Track kinds (my decision)
| Kind | Holds | Notes |
|---|---|---|
| **Video** (V1…) | video files, stills, colour/backdrop | position/scale/crop (your `region`/`card_w` today), opacity |
| **Graphics** (G1…) | HyperFrames comps | one clip = one comp (or one scene of it). Transparent over video. Two comps can share a track if they don't overlap; overlapping ones go on another G track automatically |
| **Captions** (C1) | words from `words.tsv` | editable text per word; style per track (y, max words) |
| **Audio** (A1…) | voice, SFX, music | clip gain, fades, volume keyframes, track gain, mute/solo; ducking rule on music |

Paint order top to bottom: Captions > G* > V*. Audio is summed. Tracks are typed so Claude and the UI
always know what a lane is for; default template for a Short: V1, G1, G2, C1, A1 Voice, A2–A3 SFX, A4 Music.

**HyperFrames clips are "compound clips".** Collapsed: one bar with the comp's name and a thumbnail strip.
Expand (▸): its internal tracks (`data-track-index` lanes, scenes, captions) appear read-only underneath, so you
see *what happens inside* without leaving the main timeline. Double-click opens it in HyperFrames Studio for
deep animation work.

Recommendation for new videos: **one comp per scene** instead of one comp for the whole video. Each scene is
then its own clip: it can be moved, trimmed, re-rendered and cached alone.

### 3.4 Anchors (fixes "re-voice = re-time everything")
Any clip start, SFX hit or HyperFrames cue can be **anchored** instead of a fixed number:
- to a **transcript word** (`"anchor": {"word": 42, "edge": "start", "offset": -0.05}`),
- to a **marker** (`hook`, `rules`),
- to **another clip's** start/end.

Inside comps, cue times come in as HyperFrames variables (`data-*` / variables) filled by MangoAI from anchors,
not hard-coded in GSAP. New take → new words.tsv → anchors resolve to new times → preview updates instantly;
only the comps whose cue values changed are marked stale for export.

---

## 4. Data: the project file

> Built in phase 0. The exact format is in [PROJECT_FORMAT.md](PROJECT_FORMAT.md); the sketch below is the original idea.

`<project>/cut.json` (OTIO-shaped, versioned, human-readable, small diffs). Sketch:

```jsonc
{
  "version": 1,
  "format": { "w": 1080, "h": 1920, "fps": 30, "sampleRate": 48000 },
  "markers": [ { "id": "m_hook", "t": 0, "label": "hook" } ],
  "transcripts": { "voice": "transcripts/narration.words.tsv" },
  "tracks": [
    { "id": "V1", "kind": "video", "clips": [
      { "id": "c1", "media": "edit/main.mp4", "in": 0, "out": 6.4, "start": 0,
        "transform": { "x": 540, "y": 960, "scale": 1.0 }, "keys": [] } ] },
    { "id": "G1", "kind": "graphics", "clips": [
      { "id": "g1", "comp": "animations/s01_hook", "start": 0, "dur": 6.4,
        "vars": { "counterAt": { "anchor": { "word": 3 } } } } ] },
    { "id": "C1", "kind": "captions", "source": "voice", "style": { "y": 1580, "maxWords": 3 } },
    { "id": "A1", "kind": "audio", "role": "voice", "clips": [
      { "id": "a1", "media": "audio/narration.wav", "in": 0, "out": 47.7, "start": 0.3, "gain": 0 } ] },
    { "id": "A2", "kind": "audio", "role": "sfx", "clips": [
      { "id": "s1", "media": "../../sfx_library/quick-soft-whoosh….wav", "start": { "anchor": { "marker": "m_attack" } }, "gain": -8 } ] },
    { "id": "A4", "kind": "audio", "role": "music", "gain": -24, "duckUnder": "voice", "clips": [ … ] }
  ],
  "master": { "loudness": -14, "limiter": 0.87 }
}
```

- Times in seconds (floats), snapped to frames on write. Media paths relative to the project folder
  (shared library allowed via `../../sfx_library`).
- **Importer** for existing `short.json` projects (all 15 Shorts so far): shots → V1 clips, sfx `at` lists →
  one clip each, music/narration → A tracks, captions → C1. So old projects open on day one.
- **Exporters**: OTIO (→ Resolve/Premiere/Kdenlive), and `short.json` while the plugin still needs it.

`cut.json` also holds `"revision"` (a number that goes up on every save) and a `"notes"` list (section 6).
`<project>/.mangoai/`: cache, history and drafts, never hand-edited, safe to delete (except unsaved drafts).

### Every change is an operation
All edits, from your mouse or from Claude, are the same small ops: `move`, `trim`, `split`, `delete`,
`ripple_delete`, `set_prop`, `add_clip`, `add_track`, `anchor`, … Each op is validated and recorded in the
undo history with its author (`you` / `claude`). One undo stack for both of you: "undo what Claude just did"
is one click. Your ops stay in the editor until you **Save** (section 6); Claude's ops are saved when Claude
makes them.

---

## 5. Preview engine (no rendering)

The viewer composites live in the browser, layer by layer, in track order:

- **Video clips**: decoded with WebCodecs (Mediabunny) into a `<canvas>`, frame-accurate on scrub. Playback
  uses **proxies**: on import, ffmpeg makes a 540p short-GOP H.264 copy in `.mangoai/proxies/` (seconds for a
  Short, a few minutes for a long recording, once). Export always uses originals.
- **Graphics clips**: one `<hyperframes-player>` per visible comp, stacked over the canvas, seeked to
  clip-local time. HyperFrames timelines are paused and seekable by design, so preview = render frame.
- **Captions**: drawn from the words file on an overlay canvas, same style rules as export.
- **Audio**: Web Audio API graph built from the timeline (clip gain, fades, keyframes, ducking, track gain,
  master limiter). The **audio clock is the master clock**; video and graphics follow it.
- **Waveforms**: peaks computed once per file (ffmpeg → `.mangoai/peaks/*.json`), drawn on the timeline.

Playback quality toggle (Full / Half / Quarter), like Resolve, for heavy comps.
Honest limit: preview and export use different renderers (browser vs ffmpeg+Chrome), so tiny differences can
show. A **"render this range"** button gives an exact check of a few seconds when it matters.

---

## 6. Working together: Claude drives, you Save

Claude-centric: **everything starts in the chat.** Claude builds the timeline and opens it in MangoAI. The
editor never talks to Claude. It's for watching, and for fixing things by hand when that's faster than asking.

### The loop
```
 chat: "make a Short about X"  →  Claude writes cut.json (rev 1), opens MangoAI
 you watch, then either:
   a) ask in the chat          →  Claude edits (rev 2), the editor updates live, you press play
   b) fix it yourself          →  trim, move, nudge in the editor → Save (rev 3)
 back in the chat              →  Claude sees "rev 3, saved by you: moved whoosh 18.9→18.6, trimmed s03 by 0.4 s"
 "export"                      →  Claude (or you) exports
```

### Saving
- **Save button + Ctrl+S.** A dot in the title bar shows unsaved changes. Nothing reaches `cut.json` until
  you save, so a half-finished fiddle never confuses Claude.
- **Drafts survive crashes**: unsaved edits are kept in `.mangoai/draft.json` every few seconds and offered back
  when you reopen. That's only for recovery; Claude never reads the draft.
- **Every save is a revision**: `cut.json` gets `revision + 1`, and one line goes into
  `.mangoai/history.jsonl` with who saved, when, and a plain-language summary of the ops ("moved SFX whoosh at
  18.9 s to 18.6 s"). Undo history survives across saves; any revision can be restored.

### How Claude knows something changed
1. **Automatically when you come back.** A small Claude Code hook (shipped with the video-studio plugin) runs
   when you send a message. If the open project's revision is newer than the last one Claude saw, it adds
   the summary from `history.jsonl` to Claude's context. You don't have to say "I changed things".
2. **Every Claude tool call checks too.** Claude's edits carry the revision they're based on. If you saved
   something newer in between, the edit is refused with "changed since you last looked: …", and Claude
   re-reads before trying again. Your edits are never overwritten blindly.
3. **If you have unsaved edits while Claude edits**: Claude's change still applies live, and your unsaved
   ops are replayed on top (they're small ops, so this nearly always works). If one of your ops no longer fits
   (for example, Claude deleted the clip you trimmed), the editor shows it and keeps it out. Claude's tool
   result also says "the editor has unsaved changes", so Claude can tell you to save first.

### Pointing at things: requests
You point in the editor and Claude does the work. A **request** is a small saved record of *where* plus *what*;
the editor never runs Claude itself. Two kinds cover the scenarios:

**A. "Change this animation"**
1. Click on a graphic in the viewer. MangoAI hit-tests top-down: which graphics clip is on screen at that
   point and time, then *inside* its `<hyperframes-player>` (same origin, so `elementFromPoint` works) the
   exact element: its `data-hf-id` / id, text, bounding box. Alt-click selects the whole clip instead.
2. The element gets an outline; the inspector shows "Scene s03_stats › `#stat-100k` at 0:21.4".
3. Type what you want ("count up slower, make it yellow") → **Add request**. Saved with: clip, comp file,
   element, clip-local time, a still of the frame with the element boxed.
4. Back in the chat, the hook tells Claude "1 new request". Claude edits **only that comp** (that scene's
   files), the preview reloads, only that clip goes grey on the cache bar.
5. **Versions**: before Claude touches a comp, it's copied to `.mangoai/versions/<clip>/vN`. The inspector
   gets **◀ v3 / v4 ▶** so you can flip between the old and new animation in place and keep the one you like.

**B. "Make something here" (e.g. 10:00–10:20)**
1. Drag across the ruler (or press I / O) to set the range. Optionally draw a box on the frame for where it
   should sit (CutRoomAI's region overlay: normalized 0–1, drag/resize) and drag assets from the media pool onto it
   (a logo, a screenshot).
2. Type the idea ("animated diagram of the request going through the 3 servers") → **Add request**. A striped
   **placeholder clip** appears on a free graphics track at exactly 10:00–10:20, so you see where it will go.
3. In the chat Claude picks it up with everything it needs: range, box, assets, **the words spoken in that
   range** (from the transcript, with timings, so cues land on words), the channel's look, and the scenes
   around it (to match style).
4. Claude makes a new comp sized to the box and range, then **checks it itself** before showing you: renders 3
   stills (early/middle/late) on a mid-grey background, looks at them, fixes, and reverts a "fix" that breaks
   rendering (CutRoomAI's review loop). The placeholder turns into a real clip.

Both kinds also work with no request at all: select something and say it in the chat ("make **this** bigger",
"put a chart **here**"). `selection` gives Claude the same target. Requests are for when you review a whole
video in one sitting and want to leave several at once.

Request states: `open → working → done` (or `rejected` with Claude's reason). Shown as pins on the ruler and in a
Requests panel. Saved in `cut.json` like everything else, so Save rules apply.

### Optional later: "Run now"
CutRoomAI already proved the app can run Claude Code headless (`claude --print --output-format stream-json`)
per marker, with a project lock, streamed progress and cancel-restores-the-file. A **Run now** button on a
request could reuse that so it's done while you keep watching. Off by default, to keep the design
Claude-centric (see D7).

### Claude's tools (MCP server)
| Tool | Does |
|---|---|
| `project_open / project_state` | open a project; tracks, clips, markers, revision, unsaved-changes flag |
| `changes_since(rev)` | what changed since a revision, and who changed it |
| `selection` | what you have selected, and the playhead |
| `frame(t, region?)` | a still of the live composite at t (to look before and after a change) |
| `requests_list / request_update` | read your requests (with frame stills and transcript slice), set working/done/rejected |
| `comp_create(range, region, …)` | scaffold a new comp of the right size and duration on a free graphics track |
| `comp_versions(clip)` | snapshot / list / switch versions of a comp |
| `comp_stills(clip, n)` | render n stills of one comp (on grey) for Claude's own visual check |
| `apply_ops(base_rev, ops)` | edit the timeline (validated, undoable, shown live, saved) |
| `comp_edit_done(clip)` | tells MangoAI a comp's files changed: reload preview, mark cache stale |
| `render_range / export` | exact check render, or the final export |

So "the whoosh at 0:18 is late" in the chat → Claude reads the timeline, moves one SFX clip with one op, you
press play. No render.

---

## 7. Export: render only what changed

Export plan, built from the timeline:

1. **Graphics**: each comp clip is rendered by HyperFrames to a transparent file (ProRes 4444 / alpha MOV)
   into `.mangoai/renders/`. Cache key = hash(comp files + resolved vars + duration + size + fps). Unchanged
   comps are reused. This is where nearly all render time goes today, and now it's per clip.
2. **Everything else in one ffmpeg pass**: video clips (originals, trimmed, transformed), cached graphics
   overlays, captions (ASS), and the audio mix (same mix graph as the preview, compiled to `filter_complex`),
   loudness to −14 LUFS + limiter, NVENC if available. For a 50 s Short this pass is seconds.
3. For long videos the final pass is also split into **segments between edit points** and cached, then
   joined with concat, so a change at 12:30 re-encodes only that segment.

The **cache bar** above the timeline shows green (rendered, current) / grey (stale) per range, so you see
what an export will cost before you press it. Background pre-render of stale comps can run while you edit.

---

## 8. How it fits the current workflow

- `/video-studio:plan` stays. `/short`, `/explainer` change their last step: instead of `short_build` they
  write `cut.json` and open it in MangoAI. Review happens in MangoAI; export at the end.
- `/edit-recording` can stay on Resolve for now; MangoAI gets long-form in a later phase (transcript cuts,
  proxies), with OTIO export to finish in Resolve if needed.
- HyperFrames Studio stays for building a comp's animation. Resolve stays for colour or anything MangoAI
  doesn't do.

---

## 9. Tech stack (proposed)

| Part | Choice | Why |
|---|---|---|
| Server | Node + TypeScript (Fastify, WebSocket, chokidar) | same language as UI and MCP SDK; HyperFrames is Node |
| UI | React + Vite, timeline drawn on `<canvas>` | thousands of clips/words stay smooth |
| State | single store, ops + undo log | one model for UI and Claude |
| Decode | Mediabunny (WebCodecs) | frame-accurate, no ffmpeg.wasm |
| Audio | Web Audio API | real-time mix, meters |
| Graphics | `<hyperframes-player>` + `npx hyperframes render` | already in use, deterministic |
| Media jobs | ffmpeg (local binary) for probe, proxies, peaks, final export | free, fast, NVENC |
| Claude | MCP server (`@modelcontextprotocol/sdk`, stdio → app's HTTP API) | works from Claude Code chat |
| Tests | timeline ops unit tests; golden-frame export tests on a sample project | |

---

## 10. Roadmap (each phase is usable on its own)

| Phase | You get | Done when |
|---|---|---|
| **0. Model** ✅ | `cut.json` schema, ops, short.json importer | all existing Shorts import without loss |
| **1. Viewer** ✅ | open a folder, media pool, multi-track timeline, live playback with audio, waveforms | Railway_AI_Keys plays in sync, no render (median video/audio offset 4–24 ms) |
| **2. Editing** | select/move/trim/split/ripple, snapping (playhead, markers, words), gain/fades, undo | a full Short tweak pass done by hand in the app |
| **3. Claude + Save** | MCP server (state, frame, selection, apply_ops), Save/revisions/history, the "what changed" hook, drafts | you fix something by hand, save, and Claude knows on your next message |
| **4. Requests** | click-to-target HF elements, range + region placeholders, comp versions, self-check stills | "change this" and "make something at 10:00–10:20" both work end to end |
| **5. Export** | cached per-clip HF renders + one ffmpeg pass, cache bar, loudness | a one-title change exports in seconds + one comp render |
| **6. Anchors** | word/marker/clip anchors, comp variables | re-voicing a line needs no manual re-timing |
| **7. Long-form** | proxies at scale, transcript editing, OTIO export to Resolve | a 20-min recording rough cut in MangoAI |

Phases 1–5 are the MVP for Shorts, which is where most of your videos are right now.

---

## 11. Decisions (all settled 2026-11-15)

- **D1. Name: MangoAI.** The old marker app was renamed to CutRoomAI on GitHub to free the name.
- **D2. Window: browser tab** on localhost. An Electron wrapper can come later; nothing depends on it.
- **D3. Claude-centric.** Everything starts in the chat; the editor never sends anything to Claude. Hand edits
  reach Claude through Save and revisions (section 6).
- **D4. Own ffmpeg + HyperFrames** for preview and export (no Docker needed to edit); media-toolbox only for AI
  jobs (TTS, transcribe, SFX generation).
- **D5. Shorts first**, but the model and engine are built for **50-minute videos from day one** (section 13).
- **D6. One comp per scene** for new videos.
- **D7. "Run now" button**: later and optional.
- **D8. New repo** `JohanDuran/MangoAI`, porting CutRoomAI's proven parts (section 12).

---

## 13. Long videos (30–50 min) are a first-class target

Shorts come first, but nothing may be designed so that it only works for 60 seconds. A 50-minute talking-head
or screen-recording edit is roughly: 3,000 s of source, **500–2,000 clips** after cuts, **~8,000 words** of
transcript, 50–150 SFX, 20–60 graphics scenes, one or more 50-min audio files.

| Area | What breaks at 50 min if done naively | What MangoAI does |
|---|---|---|
| Project file | Words or waveforms inlined → 5–20 MB JSON, slow saves, huge diffs | `cut.json` holds only edit data (~1 KB per clip); words stay in `words.tsv`, peaks in `.mangoai/` |
| Edits | Copying the whole project per op → laggy drags, giant undo history | Ops mutate in place through an index (clip id → track/position) and store only their inverse; undo history = ops, not snapshots |
| Anchors | Scanning 8,000 words per lookup, re-resolving everything per change | Word index (normalized word → occurrences) built once per transcript; resolve is O(clips) and cached; target < 20 ms for 2,000 clips |
| Validation | Full schema check on every keystroke | Full check on load/save; each op validates only its own payload |
| Timeline UI | One DOM node per clip/word | Canvas, drawing only the visible window; level-of-detail (words and waveforms appear when zoomed in) |
| Waveforms | One peak file at one resolution | Multi-resolution peaks (e.g. 64 / 512 / 4096 samples per pixel), loaded per visible range |
| Playback | Seeking in 50-min H.264 with 10 s GOPs | Proxies (540p, 1 s GOP), made in the background, editing allowed before they finish |
| Thumbnails | Decoding frames on the fly | Thumbnail strips per source at a few zoom levels, cached |
| Export | One 50-min render per change | Segments between edit points cached by hash; a change at 32:10 re-encodes that segment, concat for the rest |
| Graphics | One comp for the whole video | One comp per scene (D6); only scenes inside the visible window are mounted in the preview |
| Claude's view | Sending the whole timeline into context | MCP tools take a time window (`project_state(from, to)`), summaries for the rest |
| Transcript | Whole transcript in context | `transcript(from, to)` and word search |

Phase 0 includes a synthetic **50-minute benchmark** (2,000 clips, 8,000 words) that runs in the tests, so these
targets are checked from the start, not discovered in phase 7.

---

## 12. What to take from CutRoomAI

CutRoomAI (github.com/JohanDuran/CutRoomAI, 36 commits) already is a small version of request type B: markers =
time range + region + prompt + feedback, each generated by a headless Claude run, previewed live over the
video, exported only when approved.

**Port (proven):**
- `RegionOverlay.tsx`: draw / move / resize a box in normalized 0–1 coords locked to the canvas aspect.
- Marker record shape → request record: `start, end, region, prompt, feedback, status, look, assets`.
- The generate → validate → **smoke-render 3 stills → visual review on grey → revert a bad fix** loop
  (`generateMarker.ts`), ported from Remotion to HyperFrames (`hyperframes check` + snapshot stills).
- **Series**: repeated markers built from one shared component (e.g. the same "rule N" card 3 times).
- **Looks / style presets** that new animations match.
- Headless Claude runner (`claude.ts`): stream-json parsing, failure classification (not signed in, old CLI),
  project lock, cancel restores the file. Only needed for D7.
- Narration with word timings per marker, music ducking.

**Leave behind:**
- **Remotion** → HyperFrames (already your stack; avoids the license questions in `docs/remotion-license-notes.md`).
- **One video + an overlay lane** (`assignLanes` packs markers into rows) → typed multi-track timeline with
  separate audio tracks.
- **The app driving Claude for everything** → Claude-centric chat, Save + revisions.
- OpenAI TTS → your local voices (Kokoro / cloned voice via media-toolbox).

---

## Sources
- OpenTimelineIO timeline structure: https://opentimelineio.readthedocs.io/en/v0.15/tutorials/otio-timeline-structure.html
- Resolve ↔ OTIO in practice: https://docs.ayon.dev/ayon-resolve/latest/autoapi/client/ayon_resolve/otio/davinci_export.html ,
  https://prism-pipeline.com/docs/latest/general/miscellaneous/opentimelineio/ , Kdenlive track-order bug https://bugs.kde.org/show_bug.cgi?id=503692
- OpenCut: https://github.com/OpenCut-app/OpenCut , rewrite overview https://mer.vin/2026/07/opencut-explained-open-source-capcut-alternative-classic-editor-vs-ground-up-rewrite/
- Mediabunny: https://mediabunny.dev/guide/introduction , https://github.com/Vanilagy/mediabunny
- WebCodecs pipeline notes: https://dev.to/apssouza22/part-2-webcodecs-webgpu-hardware-accelerated-video-processing-pipeline-in-the-browser-kc7
- HyperFrames preview/player and Studio selection context: local skill docs (`hyperframes-cli/references/preview-render.md`)
- MLT, Final Cut magnetic timeline, Descript, Olive cache, Resolve Smart Cache / Premiere render bar: general
  knowledge of those tools, not re-checked online for this draft.
