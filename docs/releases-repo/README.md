# MangoAI

MangoAI is an AI video overlay studio for Windows. Drop in a video (or start from a blank canvas), place markers on a
timeline, and let Claude design an animated overlay for each one. Preview it live, tweak it, and export a transparent
overlay or a finished MP4.

This is a **free technical preview** for people who are comfortable with the Claude Code CLI and an OpenAI API key.
This repository only hosts the downloads; the source code is not public.

## Download

Get the latest installer from the [Releases page](../../releases/latest): `MangoAI-Setup-<version>.exe`
(about 270 MB, Windows 10 or newer, 64-bit). Check it against `SHA256SUMS.txt` if you like:

```powershell
Get-FileHash .\MangoAI-Setup-*.exe -Algorithm SHA256
```

### "Windows protected your PC"

The preview installer is not code-signed yet, so Windows SmartScreen shows an "unknown publisher" warning the first
time. Click **More info**, then **Run anyway**. The installer puts MangoAI in your user profile and needs no administrator rights.

## What you need

MangoAI brings its own video tools (ffmpeg, the renderer) and installs everything else itself. Two things are yours to
provide, and the app checks for both on first start and shows you how to fix anything missing:

| You need | Why | Where to get it |
|---|---|---|
| **Claude Code CLI**, installed and signed in | Claude designs the animations. MangoAI runs the CLI on your machine, using your own Claude plan. | [Claude Code setup](https://docs.claude.com/en/docs/claude-code/setup), then run `claude` once and sign in |
| **OpenAI API key** (optional) | Transcribing your video (Whisper) and optional AI image generation | [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Paste it into MangoAI's Status panel; it is stored encrypted for your Windows account |

Without the OpenAI key you can still use everything except transcription and image generation.

## Your data and privacy

- Projects live in `%APPDATA%\MangoAI\projects`. Logs are in `%APPDATA%\MangoAI\logs`.
- MangoAI has **no analytics and no accounts**. Nothing is sent to the author.
- Your prompts, transcript text and images go to the services you connected (Anthropic through the Claude CLI, and
  OpenAI), under your own accounts and their terms. You pay for that usage yourself.
- The OpenAI key is encrypted with Windows' per-user storage and is never written into a project or a log.

## Something went wrong?

Open MangoAI, choose **File → Save diagnostics…**, and attach the file to a new
[issue](../../issues). It contains versions, the status panel and the recent log; it does not contain your videos or
your keys. Please also say what you clicked before it happened.

## Known limits of this preview

- Windows only. Not code-signed yet (see above).
- Generated animations are code written by an AI model and run inside the app; treat projects from people you do not
  trust the way you would treat any downloaded script.
- Very long videos take a while to transcribe and export; exports need free disk space (the app checks first).

## Third-party software

MangoAI includes FFmpeg (GPL v3 build, run as a separate program), Remotion, Electron and other open-source
components. Full notices are in `THIRD-PARTY-NOTICES.txt` inside the install folder and under **Help → Third-party
notices**. Remotion is free for individuals and companies of up to three people; larger companies need a
[Remotion license](https://www.remotion.dev/license).
