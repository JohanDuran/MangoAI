---
name: sound-effects
description: Short sound effects (entrance and exit sounds, pops, ticks, chimes, impacts) that can accompany an overlay animation. Use when a short sound would enhance a key moment, for example an impact on a big title reveal, a tick on a counter, or an entrance sound for a card.
---

# Sound effects

The video usually already has speech or music, so keep sounds sparse and subtle. Add one
only when it clearly improves the animation.

## Finding a sound
Read `.claude/skills/sound-effects/catalog.json`. Each entry has an `id`, a `category`, its
`durationSeconds`, a mean level in dB (`meanVolumeDb`), and a `use` description. Pick by
`use` and `category`, and check that `durationSeconds` fits inside the marker.

## Playing it
Use `Audio` from `remotion`. The URL for a catalog entry is
`{{SKILL_URL}}/<file>` where `<file>` is the entry's `file` field. Never invent a URL and
never use a file that is not in the catalog.

```tsx
import { Audio, Sequence, interpolate } from 'remotion';

// Plays from the start of this marker:
<Audio src="{{SKILL_URL}}/maximize_001.ogg" volume={0.4} />

// Plays later. Frames are relative to the start of this marker (at 30fps, 15 = 0.5s):
<Sequence from={15}>
  <Audio src="{{SKILL_URL}}/impactPunch_medium_000.ogg" volume={0.4} />
</Sequence>

// Fade out using a frame-based volume function:
<Audio src="{{SKILL_URL}}/confirmation_002.ogg" volume={(f) => interpolate(f, [0, 20], [0.5, 0], { extrapolateRight: 'clamp' })} />
```

## Rules
- Line the sound up with the visual moment it accompanies: an entrance sound starts on the
  frame the element starts moving in, an impact on the frame it lands.
- A sound must fit inside the marker's duration. Do not loop.
- Volume is 0 to 1. Start around 0.3 to 0.5. Files with a lower mean level may need more.
  Speech in the video must stay clearly audible, so use low volumes under spoken content.
- Use at most 2 or 3 sounds per marker, and prefer one.
