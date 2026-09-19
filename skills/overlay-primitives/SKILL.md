---
name: overlay-primitives
description: Ready-made animated components (LowerThird, CalloutTextBox, CodeSnippetWindow, ImagePopup, KpiCard) from `@mangoai/remotion-overlay`. Use when one already fits the request, instead of writing the effect from scratch. Skip it when the idea needs a custom design.
---

# Overlay primitives

Import from `@mangoai/remotion-overlay`. The package source lives outside the project
directory, so you cannot read it. Use exactly the props listed here and do not guess prop
names.

| Component | Props (all optional unless marked required) |
|---|---|
| `LowerThird` | `title` string (required), `subtitle` string, `accentColor` string (default `#ff7a3d`) |
| `CalloutTextBox` | `text` string (required), `x` number (default 640), `y` number (default 200), `background` CSS color (default `rgba(20, 20, 24, 0.85)`) |
| `CodeSnippetWindow` | `code` string (required), `language` string (default `sql`), `x` number (default 640), `y` number (default 260) |
| `ImagePopup` | `src` string, path or URL (required), `x` number (default 700), `y` number (default 150), `width` number (default 420) |
| `KpiCard` | `label` string (required), `value` number (required), `suffix` string, `x` number (default 720), `y` number (default 180), `accentColor` string (default `#a6e3a1`) |

## Positioning
The default `x` and `y` values are tuned for a roughly 1280x720 area. If `regionWidth` and
`regionHeight` differ meaningfully, pass explicit `x` and `y` computed from them (for
example percentages of `regionWidth` and `regionHeight`). Otherwise content can land outside
your area, especially in a small confined region.
