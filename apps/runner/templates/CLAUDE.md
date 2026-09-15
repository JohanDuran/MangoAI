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
If the marker needs a generated image, call `node ../../scripts/generate_image.js "<prompt>" <output-path-under-02_assets>`
via Bash, then reference the resulting file from `02_assets/` in your JSX. Only do this if
you were explicitly granted Bash access for this call.

## Self-heal mode
If your instruction includes a "Validation error" section, a previous attempt failed to
compile or bundle. Read the error carefully, fix the specific problem, and keep the rest of
the component's intent intact — don't rewrite unrelated parts of the file.
