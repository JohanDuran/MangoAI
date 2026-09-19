<!-- mangoai-claude-md: 3 -->
# MangoAI Project Skill

You are editing overlay code for one marker in a MangoAI video overlay project. Follow
these rules exactly — the Node runner validates and hot-reloads your output automatically.

## Scope
- Edit **only** the single `marker_<id>.tsx` file named in the instruction you were given.
- Never edit `CustomOverlay.tsx` (the marker registry) or `Root.tsx` — the runner owns
  those and regenerates them deterministically when markers are added or removed.
- Never edit files outside `03_remotion_code/`.
- Keep the file's default export name unchanged — the registry imports it by name.

## What not to do
- Do not run `npx remotion render`, `npx remotion preview`, or any other render/build
  command. The runner validates and renders separately.
- Do not install packages or edit `package.json`.
- Do not invent new npm dependencies. Use `react` and `remotion` (already available):
  `useCurrentFrame`, `useVideoConfig`, `spring`, `interpolate`, `AbsoluteFill`, etc. A skill
  may allow additional packages; its instructions say so.

## Style guardrails
- Your component is called with `regionWidth` and `regionHeight` props — these are your
  ENTIRE available space in pixels, always. Read your layout dimensions from these props,
  never from `useVideoConfig()`'s `width`/`height` (that's the full video canvas, which may
  be larger than your assigned area) and never hardcoded. Keep every element within
  `regionWidth`/`regionHeight` with sensible margins; anything positioned beyond them is
  clipped by the runner and simply won't be visible.
- Most markers own the full canvas (`regionWidth`/`regionHeight` equal the video's actual
  size, which is not always 1280x720 or 1920x1080 — it's synced to whatever video was
  uploaded, including vertical/portrait video). Some markers are confined to a smaller
  rectangle of the screen chosen by the user (e.g. "keep this in the bottom-right corner"),
  in which case `regionWidth`/`regionHeight` are that rectangle's size, not the full canvas
  — the instruction you're given will say which case you're in. Either way, the same
  `regionWidth`/`regionHeight`-relative code works correctly.
- Overlays render on a transparent background — never set an opaque full-frame background
  color on the root element.
- Keep entrance/exit animation under ~20 frames at 30fps unless the feedback asks for
  something slower.
- Prefer `spring()` for entrances and `interpolate()` for continuous motion; avoid CSS
  transitions (they don't render frame-accurately).
- Match the tone implied by the marker's prompt and feedback — MangoAI's product principle
  is full creative freedom for composition, motion, and visual metaphor, within these
  technical constraints.

## Skills
This project may have skills installed (sound effects, image generation, ready-made
components, and others). Their names and descriptions are listed to you automatically. Load
a skill whenever its description matches what this specific animation needs, and skip the
ones that do not apply. When you use a skill, follow its instructions exactly, including which
URLs, tools and props it allows.

## Self-heal mode
If your instruction includes a "Validation error" section, a previous attempt failed to
compile or bundle. Read the error carefully, fix the specific problem, and keep the rest of
the component's intent intact — don't rewrite unrelated parts of the file.
