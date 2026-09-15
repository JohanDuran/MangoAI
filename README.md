# MangoAI

## Product Vision
MangoAI is an autonomous AI video overlay studio that turns a raw video, timeline markers, and user prompts into creative, transparent overlay compositions. The system gives the AI complete freedom to design motion, style, and visual language, while using a reliable render and preview infrastructure to guarantee a usable final output.

The product is centered on one key loop:
- create a marker
- generate a creative overlay idea
- preview it live in the browser
- tweak the prompt or code
- regenerate instantly
- export only when approved

---

## Why this matters
Most AI video tools either:
- produce generic templates with low creative variance, or
- create high-freedom content that is not actually renderable or composable in production.

MangoAI aims to combine the best of both:
- creative freedom for the agent
- structured technical execution for the system
- fast visual iteration for the user
- final export only when the quality is accepted

---

## Core Product Principle
Creative freedom for the AI, technical safety for the pipeline.

This means:
- the AI is free to choose composition, motion, tone, and visual metaphor
- the runtime enforces valid code, valid file paths, valid props, and valid output settings
- the user can inspect and revise the result before final rendering

---

## User Experience
### 1. Upload video and create markers
The user uploads a raw source video and places markers along the timeline.

Example:
- marker at 00:00:10.5
- prompt: "Add an animated lower third for a product announcement"
- feedback: "make it more cinematic and subtler"

### 2. Preview overlay immediately
Instead of waiting for a final video export, the user sees the overlay live on top of the original video via a dual-layer player.

### 3. Inspect generated code
Each marker includes a button to inspect the generated Remotion/TSX code. This makes the interface feel like a real design studio rather than a black-box generator.

### 4. Regenerate a single marker
The user can adjust text, prompt intent, or code feedback and regenerate just that segment without redoing the whole video.

### 5. Final export
When satisfied, the user triggers the final render to produce the transparent overlay output.

---

## System Architecture

### High-level flow

```text
[ Frontend Web Editor ]
    │
    ├── create/edit markers
    ├── inspect generated code
    ├── preview overlay in real time
    └── regenerate selected marker
            │
            ▼
[ Local Project Directory: /proyectos/<project_id>/ ]
            │
            ▼
[ Local Agent Runner (Node.js / HTTP API) ]
            │
            ▼
[ Claude Code CLI, headless: `claude --print --output-format stream-json` ]
    ├── native Read/Write/Edit/Glob/Grep (scoped to project dir)
    ├── native Bash (only for project init / asset generation calls)
    └── generate_image.js (local script, called via Bash, hits OpenAI's API)
            │
            ▼
[ Node runner validates output (tsc / bundle check) ]
    ├── valid  ──► A. Browser hot reload preview
    └── invalid ─► re-invoke Claude with error, up to 3 attempts
            │
            ▼
[ Final export: Node runs `npx remotion render` directly (no Claude) ]
[ /04_output/overlay.webm or ProRes 4444 ]
```

No custom MCP servers are required for v1. Claude Code's built-in tools already cover
filesystem and terminal access, scoped to the project directory via `--allowedTools` and the
working directory of the headless process. The only external capability gap is image
generation, which is a plain script Claude calls via Bash — not a protocol server.

### Main responsibilities
#### Frontend editor
- timeline marker management
- video preview layer
- Remotion Player overlay layer
- code inspection drawer/modal
- prompt and feedback controls
- final export button

#### Local runner
- expose an HTTP API for the editor (create/regenerate marker, export)
- build the prompt for each Claude invocation from marker payload + CLAUDE.md
- spawn `claude --print` headless, scoped to the project directory, with tools
  restricted per call type (no Bash for regen/self-heal)
- track one active child process per project; kill and replace on a new request
- parse `stream-json` output and forward progress to the frontend
- validate generated code (type check / bundle dry-run) before signaling hot-reload
- own the self-heal retry loop (re-invoke Claude with the error, up to 3 attempts)
- run `npx remotion render` directly for final export — no Claude involved

#### Claude agent loop (headless, one focused call per trigger)
- read the current marker's code and the marker payload it's given
- understand the prompt/feedback for that specific marker
- generate or update TSX/React overlay code for that marker only
- call the image-generation script via Bash when new assets are needed
- on a self-heal trigger, rewrite code given the validation error it's handed
- never runs the render or preview itself — that's the Node runner's job

#### Remotion engine
- render overlays in browser preview
- compile final composition for export
- support transparent output formats

---

## Real-Time Preview Loop
This is the product’s differentiator.

### Why it matters
The user should not wait for a full export every time they tweak a prompt.

### How it works
- the raw video remains in the background
- a Remotion Player is layered on top with absolute positioning
- both layers are synchronized by time state
- when Claude modifies overlay code, the browser hot-reloads the composition
- the user sees the animation instantly without producing a final output file

### UX stack
- video timeline
- overlay preview
- current marker details
- generated code panel
- feedback textarea
- regenerate button

---

## Triggering Mechanism
This is the piece that makes the rest of the system real: how the Node runner actually
invokes Claude, gets a result back, and keeps the UI in sync.

### Trigger source
The editor calls the local Node HTTP API directly (e.g. `POST /projects/:id/markers/:markerId/regenerate`)
on user action — no file watcher. The editor is the only thing that ever changes marker
state, so a direct call is simpler and deterministic, and gives an obvious hook for
progress streaming and cancellation.

### Invocation
Node spawns Claude Code headless for that one request:
```bash
claude --print "<templated prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Glob,Grep" \
  --permission-mode acceptEdits
```
run with `cwd` set to the project directory, so file access is naturally scoped without
needing a custom filesystem tool. Bash is only added to `--allowedTools` for project-init
or asset-generation calls that need `generate_image.js`.

### Prompt construction
The runner builds the prompt from the marker payload (id, start, end, prompt, feedback,
current code) plus a pointer to the project's CLAUDE.md conventions, and explicitly tells
Claude not to run render or preview commands — validation and rendering are the runner's job.

### Process lifecycle
- one active child process per project; a new regenerate request sends SIGTERM to any
  in-flight run before spawning the next, so two edits can't race on the same TSX file
- `stream-json` lines are parsed and forwarded to the frontend over SSE/WebSocket so the
  UI can show "reading marker...", "writing update...", "done" instead of going silent
- on exit, the runner validates the written code (type check / Remotion bundle dry-run)
  before telling the frontend to hot-reload

### Self-heal loop
Retrying lives in the Node runner, not in a single Claude run looping on itself:
```
generate → validate → on failure: re-invoke with the error appended → retry (max 3) → surface error to user
```
Each retry is a fresh headless call with the previous error as context, which keeps each
step small, inspectable, and logged to `05_debug/`.

---

## Marker Regeneration Model
Each timeline segment should be treated as a reusable creative unit.

### Marker payload example
```json
{
  "marker_id": "m1",
  "start": 10.5,
  "end": 18.0,
  "prompt": "Optimización PL/SQL text popup",
  "feedback": "Make the animation fade in from bottom instead of zoom in",
  "current_code": "import { spring, useCurrentFrame } from 'remotion'; ..."
}
```

### Regeneration workflow
1. user selects a marker
2. user edits prompt or feedback
3. editor sends targeted payload to project state
4. local watcher triggers the Claude regeneration workflow
5. Claude updates the relevant TSX or configuration
6. browser hot-reloads the player
7. user validates the updated overlay

---

## Folder Structure
```text
/proyectos/<project_id>/
├── project.json
├── CLAUDE.md
├── 00_input/
│   ├── raw_video.mp4
│   ├── markers.json
│   └── preview_state.json
├── 01_transcript/
│   └── transcript.json
├── 02_assets/
│   ├── asset_manifest.json
│   └── img_01.png
├── 03_remotion_code/
│   ├── CompositionConfig.json
│   ├── CustomOverlay.tsx
│   └── marker_m1.tsx
├── 04_output/
│   ├── overlay.webm
│   ├── final_export.mov
│   └── render_log.txt
└── 05_debug/
    ├── errors.json
    ├── failed_attempts.log
    └── code_history/
```

---

## Implementation Roadmap

### Phase 1: Foundation and local infrastructure
**Objective:** set up the local system that can generate, preview, and render overlays.

Tasks:
- initialize Remotion project
- configure transparent export support
- set up project directory conventions
- create local Node runner with HTTP API (no file watcher needed)
- create base composition and layout primitives

Deliverables:
- working project generator
- basic overlay primitives library
- local project folders with standard naming

---

### Phase 2: Agent orchestration and project memory
**Objective:** build a reliable Claude-driven pipeline for project generation.

Tasks:
- define CLAUDE.md instruction contract
- build the headless Claude Code invocation module (prompt templating, `--allowedTools`
  scoping per call type, `stream-json` parsing)
- add transcript and marker ingestion
- define the prompt-to-code generation loop
- establish code-generation conventions

Deliverables:
- working agent loop for project generation
- prompt and state capture from markers
- repeatable project initialization flow

---

### Phase 3: Live preview and editing loop
**Objective:** enable fast in-browser iteration.

Tasks:
- connect Remotion Player to editor
- sync video playback and overlay playback
- build code inspection modal/drawer
- build feedback panel for prompt refinement
- add targeted regeneration for a marker

Deliverables:
- instant live preview flow
- per-marker editing workflow
- regeneration system without full export

---

### Phase 4: Self-healing render engine
**Objective:** make the system resilient to code execution errors.

Tasks:
- validate generated code (type check / bundle dry-run) after every headless run, before
  signaling hot-reload
- parse validation errors into a clean diagnostic string
- re-invoke Claude headless with the error appended to the prompt
- cap retries at 3 attempts, then surface the failure to the user
- log each attempt's prompt, diagnostic, and resulting diff to `05_debug/`

Deliverables:
- auto-repair workflow
- reliable render retries
- logged history of code changes

---

### Phase 5: Final export and production polish
**Objective:** produce final transparent overlays efficiently.

Tasks:
- final render pipeline to .webm / ProRes
- export confirmation UI
- project versioning
- final validation layer
- rendering queue or explicit export trigger

Deliverables:
- final export flow
- quality control step
- production-ready output handoff

---

## Technical Stack
### Frontend
- React
- Vite or Next.js for local editor
- Remotion Player
- CSS for dual-layer preview UI

### Backend / local orchestration
- Node.js
- local HTTP API (marker regen, project init, export)
- SSE/WebSocket for streaming Claude's progress to the editor

### AI orchestration
- Claude Code CLI, headless (`claude --print --output-format stream-json`)
- per-call `--allowedTools` scoping (no Bash for regen/self-heal)
- `generate_image.js` local script for OpenAI image generation, called via Bash

### Rendering
- Remotion
- transparent video output
- .webm alpha or ProRes 4444

---

## Product Principles
### 1. Full creative freedom
The AI should be free to invent visual metaphors, motion patterns, and presentation ideas.

### 2. Technical safety via validation
The system should validate generated code before final approval and should repair broken output automatically.

### 3. Preview before export
The user should see the result live before paying the cost of a final render.

### 4. Marker-level iteration
Edits should happen at the segment level, not only at the whole-project level.

### 5. Final export only when approved
The system should save the expensive render step for the last mile.

---

## Risks and Mitigations
### Risk: unstable AI-generated TSX
**Mitigation:** maintain a repair loop, consistent file conventions, and schema-driven props.

### Risk: slow iteration due to final render cost
**Mitigation:** preview loop via Remotion Player before final export.

### Risk: inconsistent output styles
**Mitigation:** allow the AI creative freedom but maintain style guidance in CLAUDE.md.

### Risk: project complexity grows too quickly
**Mitigation:** keep a strict stage-based directory structure and modular marker code file strategy.

---

## MVP Definition
The first viable version should include:
- single-video upload
- marker creation on a timeline
- prompt-based overlay generation
- dual-layer preview with raw video + overlay
- code inspection for generated marker overlays
- regenerate selected marker with feedback
- final export of transparent overlay video

This MVP delivers the complete creative loop without requiring a full multi-project production feature set.

---

## Long-Term Vision
MangoAI can evolve into a production-grade AI-first overlay studio for:
- creator workflows
- marketing video editing
- technical demo overlays
- training and tutorial videos
- product highlight editing
- AI-assisted post-production

The strategic advantage is not simply “AI generates effects.” It is the combination of:
- creative autonomy
- immediate visual feedback
- marker-level editing
- render reliability
- final output control

---

## Next Action
The next step is to build the first MVP skeleton:
1. project folder conventions
2. local Node watcher
3. basic Remotion preview player
4. simple marker editor
5. one prompt-to-overlay generation flow
6. one regeneration loop
7. one export action

This is where the idea transitions from design concept into real implementation.
