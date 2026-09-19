---
name: image-generation
description: Generate an image from a text prompt with the generate_image tool. Use when the creative intent calls for an illustration, photo, or picture, especially one that simple shapes and text cannot express well.
---

# Image generation

You have one tool, `generate_image`, which takes a `prompt` and returns a URL for a generated
image. It costs money and takes 10 to 60 seconds, so use it at most once or twice per marker.
The user has enabled it for this request, so use it whenever the creative intent mentions or
implies a photo, illustration, or picture.

## Using the result
The tool returns a URL. Use it exactly as given:

```tsx
<img src="URL_FROM_TOOL" style={{ width: regionWidth * 0.4 }} />
```

or pass it as the `src` prop of the `ImagePopup` primitive. Do not invent image URLs or use
local file paths.

## Writing a good prompt
- Describe the subject concretely (what, style, composition), not the animation.
- The overlay is transparent video, but generated images are opaque squares. Design around
  that: frame the image in a card, a rounded mask, or a popup.
- Avoid text inside the image. Render text as text in the component instead.

If the tool fails, fall back to a text or shape based design. Do not retry more than once.
