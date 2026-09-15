Application Name: MangoAI

System Architecture & Implementation Plan: Autonomous AI Video Overlay Engine
This document outlines the long-term architecture and step-by-step implementation plan for an autonomous AI video overlay system driven by Claude (via local agentic loops/MCPs), Remotion, and a real-time preview pipeline.

Core Product Vision
MangoAI is not just an AI overlay generator. It is a creative production system that gives an autonomous agent full freedom to compose moments, visual metaphors, and motion language, while still being grounded in a reliable render pipeline and instant preview loop.

The key design principle is:
- Creative freedom for the AI
- Technical safety for the pipeline
- Instant visual feedback for the user
- Final export only when the result is approved

System Architecture Overview
The system operates as an Autonomous Event-Driven Agentic Pipeline.

The frontend editor acts as the creative interface for timeline markers, prompt editing, live preview, and code inspection, while a local Node.js runner triggers a fully autonomous Claude Agent Loop that leverages Model Context Protocol (MCP) servers to manage assets, write dynamic Remotion code, auto-correct compilation errors, and ultimately render the final overlay.

Plaintext
[ Frontend Web Editor ]
    │
    ├── 1. Saves project data / markers JSON
    │
    ├── 2. Shows raw video + live Remotion overlay preview
    │
    ├── 3. Opens generated code modal for inspection
    │
    └── 4. Allows targeted prompt or code feedback regeneration
            │
            ▼
[ Local Project Directory: /proyectos/<project_id>/ ]
            │
            ▼
[ Local Agent Runner (Node.js / File Watcher / Webhook Trigger) ]
            │
            ▼
[ Claude Agent Loop + MCP Infrastructure ]
   ┌─────────────────────────────────────────────────────────┐
   │                  CLAUDE AGENT LOOP                      │
   │  Self-healing, reasoning, open-ended composition       │
   │                                                         │
   │  MCP Tools:                                             │
   │  ├── Filesystem MCP  ──► Read transcripts, markers,     │
   │  │                       code, project state             │
   │  ├── OpenAI MCP      ──► Generate images/assets         │
   │  ├── Remotion MCP    ──► Create/modify TSX components   │
   │  └── Terminal MCP    ──► Run render and diagnostics      │
   └─────────────────────────────────────────────────────────┘
            │
            ├── A. Instant React hot reload preview in browser
            │
            └── B. Final export: transparent alpha video
[ /04_output/overlay.webm or ProRes 4444 ]

Expanded Real-Time Preview Architecture
The critical innovation is the preview loop.

You do not need to wait for the full final video render every time a prompt changes. Since Remotion is React-based, the editor can embed Remotion Player directly and preview the overlay in real time while the raw video plays underneath.

Plaintext
[ Frontend Web Editor ]
   │
   ├── 1. Video Player with Dual Layer:
   │      ├── Background: Original Raw Video (<video src="raw_video.mp4" />)
   │      └── Foreground Overlay: <Player /> (Remotion React Component in real-time)
   │
   ├── 2. Marker Overlay Toolbar:
   │      └── Button: "View Generated Code" ──► Opens TSX Modal
   │
   ├── 3. Fast Regeneration Trigger:
   │      └── Edit Marker Prompt + Code Context ──► Calls Claude Agent ──► Hot-reloads Component
   │
   └── 4. Final Export Trigger:
          └── "Export Final Video" ──► Runs Stage 04 render

This allows the user to iterate on a marker as if it were a live design surface instead of waiting for an entire export each time.

Step-by-Step Implementation Strategy

1. Real-Time In-Browser Preview (No Full Render Required)
Instead of executing npx remotion render every time a marker is added or modified, embed @remotion/player in the frontend web editor.

Dual-Layer Canvas:
- stack the raw video behind the Remotion Player using absolute positioning
- synchronize play/pause and currentTime states between raw video and overlay component

Instant React Reloads:
- when Claude updates 03_remotion_code/CustomOverlay.tsx or CompositionConfig.json
- the local editor hot-reloads the Remotion component instantly
- the user sees the animation live without generating a final .webm export

This turns the experience into a fast creative loop instead of a render queue.

2. Code Inspection & Contextual Prompt Editor
For every timeline segment, add an interactive UI layer to inspect and refine the generated design.

Features:
- "Inspect Code" button over each active animation segment
- modal or drawer showing the raw React/TSX code generated for that marker
- feedback textarea that allows user prompt improvements like:
  "Make the entrance rotation faster and change the background to dark navy"

This creates a closed loop between visual output and code understanding.

3. Targeted Marker Regeneration Loop
This is where the system becomes truly responsive.

When the user clicks Regenerate Marker, the editor sends a targeted update payload for a single marker ID:

JSON
{
  "marker_id": "m1",
  "start": 10.5,
  "end": 18.0,
  "prompt": "Optimización PL/SQL text popup",
  "feedback": "Make the animation fade in from bottom instead of zoom in",
  "current_code": "import { spring, useCurrentFrame } from 'remotion'; ..."
}

The local watcher invokes Claude with a surgical instructions payload:

Bash
claude --print "Update marker m1 in ./proyectos/my-video. Use current_code and feedback as context to rewrite 03_remotion_code/CustomOverlay.tsx."

Then:
- Claude modifies the relevant TSX code
- the browser hot-reloads the player
- the user sees the change immediately
- the system continues iterating until the preview feels right

4. Final Full-Video Export (Stage 04)
Once the user is satisfied with all live previews and marker edits, they click a single "Export Final Video" button.

This triggers the final render stage:
- npx remotion render
- output to transparent .webm or ProRes 4444
- final overlay exported for production use

Only at this moment do we spend the expensive full render time.

Folder & Stage Structure (/proyectos/<project_id>/)
Each project follows a strict staging convention to ensure traceability, modularity, and debugging:

Plaintext
/proyectos/<project_id>/
├── project.json                 # Global metadata and settings
├── CLAUDE.md                    # Project-specific skill & system instructions
├── 00_input/
│   ├── raw_video.mp4            # User uploaded raw video
│   ├── markers.json             # Timeline ranges, prompt data, feedback, marker IDs
│   └── preview_state.json       # Optional current preview settings / active marker
├── 01_transcript/
│   └── transcript.json          # Timestamped spoken text (Whisper)
├── 02_assets/
│   ├── asset_manifest.json      # Index of generated images/graphics
│   └── img_01.png
├── 03_remotion_code/
│   ├── CompositionConfig.json   # Props and settings passed to Remotion
│   ├── CustomOverlay.tsx        # Main overlay composition hot-reloaded live
│   └── marker_m1.tsx            # Optional modular TSX code per marker for quick inspection
├── 04_output/
    ├── overlay.webm             # Transparent video overlay output
    ├── final_export.mov         # Optional ProRes 4444 output
    └── render_log.txt           # Logs, error traces, and retry history

Implementation Plan (Phased Roadmap)

Phase 1: Core Setup & MCP Infrastructure
Remotion Template Foundation:
- set up a clean Remotion project supporting transparent outputs
- support .webm with alpha or .mov ProRes 4444
- create a reusable library of animation primitives:
  - lower thirds
  - callout text boxes
  - code snippet windows
  - image popups
  - KPI cards

MCP Configuration:
- Filesystem MCP: access local project directories
- OpenAI MCP: generate visual assets/images on-demand
- Terminal/Command MCP: run npx remotion render and diagnostics

Phase 2: Skill & Context Definition (CLAUDE.md)
Create a system skill contract defining:
- agent behavior
- creative style guardrails
- color / typography guidance
- max animation durations
- self-healing loop rules

Self-healing protocol:
- capture Remotion rendering errors
- inspect stack traces
- rewrite broken TSX or JSON props
- retry compilation automatically up to 3 times

Phase 3: Automatic Trigger & Runner
Develop a lightweight Node.js watcher or local HTTP endpoint.

This watcher listens for marker edits or prompt changes and triggers:

Bash
claude --print "Execute the 'Video Overlay Generation Workflow' skill for ./proyectos/my-video"

It also supports a targeted regeneration job for a single marker.

Phase 4: Preview Pipeline & UX Feedback Loop
Integrate @remotion/player into the editor and display:
- raw source video
- live overlay preview
- generated code drawer
- targeted prompt improvement panel

The user can iterate on each marker without waiting for final export.

Phase 5: Final Export & Production Readiness
Test with complex user prompts and creative overlay styles.

Optimize token usage by providing compact, pre-validated JSON schemas for Remotion props rather than requiring the agent to regenerate boilerplate from scratch each time.

Key Architectural Strengths
Maximum Creative Flexibility:
- Claude retains full freedom to reason about user intent, visual metaphors, motion language, and composition.

Self-Correction:
- unlike rigid workflow engines, the agent catches syntax or compilation errors, repairs the code, and retries automatically.

Instant Visual Feedback:
- the user sees the result immediately in the preview layer before paying the cost of the final export.

Production-Ready Iteration:
- the preview loop handles quick adjustments, while the final render is reserved for approved outputs only.

Zero Direct API Integration Overhead:
- the backend remains lightweight and filesystem-driven while Claude orchestrates the creative work across tasks.

Core Strategic Positioning
MangoAI is best positioned as a creative co-pilot for overlay production:
- not a rigid template generator
- not a limited motion library
- not a one-click export tool

It is an autonomous visual reasoning engine that can:
- understand a marker prompt
- inspect raw video context
- generate creative overlay code
- preview it live in the browser
- refine it through feedback loops
- only then export the final overlay video

This makes MangoAI both expressive and operationally reliable, which is the balance needed for a truly useful AI video production system.