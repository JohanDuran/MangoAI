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
- Do not invent new npm dependencies. Use only `react` and `remotion` (already available):
  `useCurrentFrame`, `useVideoConfig`, `spring`, `interpolate`, `AbsoluteFill`, etc.
- You may import shared primitives from `@mangoai/remotion-overlay` instead of writing an
  effect from scratch when one already fits. You cannot read their source (it lives outside
  this project directory), so use exactly the props listed below — do not guess prop names.

  - `LowerThird`: `title` (string, required), `subtitle?` (string), `accentColor?` (string,
    default `#ff7a3d`)
  - `CalloutTextBox`: `text` (string, required), `x?` (number, default 640), `y?` (number,
    default 200), `background?` (string CSS color)
  - `CodeSnippetWindow`: `code` (string, required), `language?` (string, default `sql`),
    `x?` (number, default 640), `y?` (number, default 260)
  - `ImagePopup`: `src` (string, required — path or URL), `x?` (number, default 700), `y?`
    (number, default 150), `width?` (number, default 420)
  - `KpiCard`: `label` (string, required), `value` (number, required), `suffix?` (string),
    `x?` (number, default 720), `y?` (number, default 180), `accentColor?` (string, default
    `#a6e3a1`)

## Style guardrails
- The instruction you're given states the project's actual video canvas size in pixels.
  Treat that as ground truth — read it via `useVideoConfig()` in your component (never
  hardcode a different width/height) and keep every element within those bounds with
  sensible margins. This project's canvas is not always 1280x720 or 1920x1080 (it's synced
  to whatever video was actually uploaded, including vertical/portrait video), so don't
  assume a standard 16:9 frame.
- The shared primitives' default `x`/`y` values (listed above) are tuned for a roughly
  1280x720 canvas. If the stated canvas size differs meaningfully, pass explicit `x`/`y`
  (ideally computed from `useVideoConfig()`'s `width`/`height`, e.g. percentages of them)
  instead of relying on those defaults — otherwise content can land outside the frame.
- Overlays render on a transparent background — never set an opaque full-frame background
  color on the root element.
- Keep entrance/exit animation under ~20 frames at 30fps unless the feedback asks for
  something slower.
- Prefer `spring()` for entrances and `interpolate()` for continuous motion; avoid CSS
  transitions (they don't render frame-accurately).
- Match the tone implied by the marker's prompt and feedback — MangoAI's product principle
  is full creative freedom for composition, motion, and visual metaphor, within these
  technical constraints.

## Assets
You cannot generate images yourself — you have no Bash access. If the instruction includes
a line starting "An image has already been generated for this marker", a URL is provided;
use it directly (`<img src="...">` or the `ImagePopup` primitive's `src` prop). If no such
line is present and the creative intent calls for a photo/illustration, use a text- or
shape-based primitive instead — do not attempt to work around the lack of image access.

## Self-heal mode
If your instruction includes a "Validation error" section, a previous attempt failed to
compile or bundle. Read the error carefully, fix the specific problem, and keep the rest of
the component's intent intact — don't rewrite unrelated parts of the file.
