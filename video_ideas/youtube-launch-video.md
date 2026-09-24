# MangoAI launch video — planning doc

Core angle for everything below: MangoAI doesn't pick from a template library —
Claude writes the actual animation code for each overlay, based on what you type,
what's in the frame, and (optionally) images you give it. That's the one idea the
whole video should serve.

---

## Title

Pick one, don't combine:

1. **"I taught Claude to add motion graphics to my videos"** — recommended. Plain,
   curiosity-driven, states exactly what happens with no hype words.
2. "This AI doesn't caption your video — it animates it"
3. "I built an AI video editor that writes its own animations"
4. "Claude just replaced my After Effects workflow"
5. "AI-generated motion graphics, from one sentence"

## Thumbnail

Keep on-image text under 4 words. Pick one:

1. **Split-screen before/after** (recommended) — left half: plain talking-head
   frame. Right half: same frame with a bold animated card/chart overlaid. Text:
   "0 → THIS" or just an arrow between the two halves.
2. **Code-to-graphic reveal** — a short code snippet on one side, an arrow, the
   rendered animated overlay on the other. Signals "writes real code," not
   "picks a filter."
3. **Bold claim + your face** — you reacting, big text like "AI EDITS VIDEO NOW"
   over a blurred screenshot of the marker timeline in the background.
4. **Timeline shot** — screenshot of the actual marker timeline with one marker
   highlighted and its generated overlay floating above it, labeled "1 sentence
   → this."

Recommendation: #1 or #2 — both show the result instantly, which matters more
for click-through than showing the UI first.

---

## Script outline

Rough timing for a 3.5–4 minute video. Adjust to footage you actually have.

### 0:00–0:08 — Hook
Spoken over screen capture, cut straight to a finished animated overlay landing
on screen (don't explain yet, just show it):

> "This video has zero manual animation in it. I typed what I wanted, and an AI
> wrote the actual code for every graphic you're about to see."

### 0:08–0:25 — The promise / the pain it replaces
Quick contrast: show a plain, flat clip, then name what people currently do to
avoid that (After Effects, template packs, captions apps that only do captions).

> "Normally that means After Effects, or picking from a template library that
> looks like everyone else's. This is neither — Claude designs and animates it
> from scratch, for this specific video."

### 0:25–2:30 — Demo walkthrough
Screen-recorded, narrated. Suggested beats, in order, matching what the tool
actually does:

1. **Upload a video.** Show the raw clip in the editor.
2. **Drop a marker on the timeline.** Drag a range, type a plain-language
   prompt (e.g. "animated bar chart of tax prep time"), hit generate. Show the
   preview updating live.
3. **Confine it to a region.** Draw a box so the animation stays in a corner
   instead of taking the full frame — show the same prompt producing a layout
   that fits that smaller area.
4. **Attach an image.** Upload a logo or screenshot, attach it to a marker,
   regenerate — show Claude deciding how to frame it (card, corner badge,
   background) rather than just slapping it on screen.
5. **Auto-plan from the transcript.** Transcribe the video, click "Plan
   markers," show Claude proposing several overlay moments on its own, with
   suggested images attached — then approve/edit before generating.
6. **Export.** Show the final rendered MP4 with everything composited onto the
   real video.

Keep this section moving — cut dead air out of every generation wait, don't
show more than 2–3 full generations in real time.

### 2:30–3:15 — How it works (the "how" beat)
One short explanation, no jargon dump:

> "Under the hood, each of those overlays is a real animated component —
> Claude reads the time range, what's being said, the shape of the space it
> has to work with, and any images I gave it, then writes the actual motion
> graphics code. It's not filling in a template — it's designing one, every
> time."

Optional visual: a glimpse of the generated code scrolling by, then cut back to
the rendered result.

### 3:15–3:45 — Honesty beat
One sentence naming a real limitation — this builds trust and headroom for a
part 2 video. Options: generation takes a little time per marker, it's early
and rough around some edges, you still pick where markers go.

### 3:45–4:00 — CTA
What you want the viewer to do — try it, follow for updates, comment with what
they'd use it for. Keep it to one ask.

---

## Notes
- Lead every section with the result on screen before the explanation — the
  hook technique ("show, then tell") works the same way at 0:00 and at 2:30.
- Don't show more than one full "type a prompt → wait → result" cycle in real
  time; speed up or cut the rest.
- If you have footage from your own build-in-public sessions (e.g. the DIY
  gutter-install video you used to test exports), that's a natural piece of
  demo content — real video, real narration, real overlays.
