# MangoAI — Shippable Executable: Release Plan (v1 Technical Preview)

Goal: a downloadable installer you can hand a link to, aimed at **technical early users** (people comfortable with the Claude Code CLI and an OpenAI API token). Free, closed-source, installer handles environment checks. This doc is the roadmap to get there — it does not require opening the repo or the product up further than that.

## 1. Ground truth: what exists today

- **Not a desktop app yet.** It's a monorepo run as two dev processes: `apps/editor` (React/Vite SPA) and `apps/runner` (Express/TypeScript backend run live via `tsx`, no compiled `dist`). `packages/remotion-overlay` is a shared Remotion composition library the runner bundles/renders with.
- **Claude access = CLI subprocess only.** `apps/runner/src/lib/claude.ts` spawns the `claude` binary directly (`--print`, `--output-format stream-json`, etc). There is no Anthropic SDK and no API-key path — a user **must** have Claude Code CLI installed and signed in.
- **OpenAI access = raw `fetch`, no SDK.** Whisper transcription (`transcript.ts`) and image generation via `gpt-image-1` (`skills/image-generation/server.mjs`, an MCP server the runner spawns) both read `OPENAI_API_KEY` from a plaintext `apps/runner/.env`.
- **ffmpeg/ffprobe are required on PATH** and are not bundled anywhere (no `ffmpeg-static`). Several code paths shell out to them directly.
- **All project data lives inside the repo** at `apps/runner/proyectos/<project_id>/...` — there's no OS user-data directory concept yet.
- **No packaging pipeline exists at all**: no Electron/Tauri/pkg config, no CI (`.github` doesn't exist), nothing is compiled — the runner ships as raw TS run through `tsx`.
- **No auth, licensing, or telemetry** — nothing to rip out, but also nothing to reuse for update checks or crash reports.
- Small codebase (~7k lines TS/TSX, ~81 files) — this is a scoped, doable packaging project, not a rewrite.

## 2. Key decision: wrap it as an Electron desktop app

This is the one architectural call the rest of the plan hangs off, so stating the reasoning:

- A single installer (NSIS on Windows, dmg on Mac) is the only way to satisfy "the installer takes care of all the checks" *and* "share a link to download" without asking users to install Node themselves — Electron ships its own Node/Chromium runtime.
- It lets you **bundle ffmpeg/ffprobe** as resources, which removes an entire manual-install step for users.
- It gives you a real settings surface (native window, `safeStorage` for the OpenAI key) instead of a `.env` file the user has to hand-edit.
- Packaging into an `asar` archive is a reasonable "don't casually browse my source" bar for a free technical preview — it is not real code protection (asar is trivially unpacked), so treat this as a business decision (free + closed for now, not source-available) rather than a security one. Real protection would mean a paid, licensed build later; not needed for v1.
- Claude Code CLI itself can't be bundled the same way — it's Anthropic's own tool with its own login/subscription. The app can only **detect and guide**, not install-and-forget.

Alternative considered and rejected for v1: ship the existing two Node processes plus a "run me" script and tell users to open a browser tab. Simpler to build, but it still requires a Node check, doesn't hide code at all, and doesn't give you a real installer — it fails the brief on its own terms.

## 3. What "the installer takes care of all the checks" actually breaks down into

| Prerequisite | v1 approach |
|---|---|
| Node runtime | Solved by Electron bundling its own — not a user-facing check at all. |
| ffmpeg / ffprobe | Bundle via `ffmpeg-static`/`ffprobe-static` (or platform binaries in `extraResources`); update the `spawn('ffmpeg'...)` call sites in `transcript.ts`, `assets.ts`, `baseClip.ts`, `projects.ts` to use the bundled path. Removes the check entirely. |
| Claude Code CLI installed + signed in | Runtime check (`claude --version`, and a lightweight "are you logged in" probe), surfaced as a first-run/settings screen with an "Install Claude Code CLI" link and a "Recheck" button. App should degrade gracefully (marker editing works, AI generation is disabled) rather than hard-block startup if missing. |
| OpenAI API key | Settings screen where the user pastes the key; validate with a cheap `GET /v1/models` call; store via Electron `safeStorage` (OS keychain-backed), not a plaintext `.env`. |
| GPU encoder (nvenc vs libx264) | Already has a runtime fallback in the code — just surface the result in the UI instead of failing silently. |
| Remotion's Chrome headless shell | `@remotion/renderer` downloads this on first render. Pre-fetch it into the installer's resources so first run doesn't depend on the user's network/firewall. |
| Project data location | Move `PROJECTS_ROOT` (`apps/runner/src/lib/paths.ts`) from the repo-relative `proyectos/` folder to `app.getPath('userData')`. |

## 4. Robustness improvements to the app itself

Findings from reading the runner/editor code (file references are where the issue lives today). Tiers: **P0** = fix before anyone else runs it, **P1** = fix for a credible v1, **P2** = after launch. There are no tests, lint, or CI in the repo today (no `*.test.*` files, no `test`/`lint` scripts), so none of this is currently guarded.

### P0 — security and "can't corrupt or hang the user's machine"

1. **Lock down the local server.** `index.ts:10` uses wide-open `cors()` and `index.ts:51` calls `app.listen(PORT)` with no host, so it binds all interfaces. Any web page the user visits, or any device on their LAN, can call an API that spawns `claude` with `--permission-mode acceptEdits`, deletes projects, and serves files. Fix: bind `127.0.0.1` only, generate a random per-launch token that Electron injects and the server requires, drop open CORS (packaged app is single-origin), and pick a free port instead of fixed 5175. The editor's hard-coded `BASE = 'http://localhost:5175'` (`apps/editor/src/api/client.ts:1`) must become relative/injected.
2. **Validate ids at the door.** `projectDir(id)` (`paths.ts:10`) joins the raw `req.params.id` into a path; only the delete route checks containment (`projects.ts:155`). Add one `app.param` guard (strict regex for project, marker, and asset ids/filenames) so no route can traverse out of the projects folder, and sanitize the uploaded video extension (`video.ts:28`).
3. **Claude process hardening** (`claude.ts:96-171`).
   - No timeout, no cancel, and nothing kills the child when the client disconnects or the app quits, so a hung run blocks that project's queue forever (`withProjectLock`). Add a per-attempt timeout, kill the whole process tree on Windows (`taskkill /T`), abort on SSE close, and kill children on shutdown.
   - The prompt goes in as an argv argument, and it embeds full current code + transcript + asset list (`buildRegeneratePrompt`, `claude.ts:222-261`). Windows caps a command line at ~32K characters, so long transcripts can make `spawn` fail. Send the prompt over stdin instead (verify against the installed CLI; note the existing comment about stdin causing a ~3s wait when left open, which closing it after writing avoids).
4. **Classify Claude failures instead of "exit code N".** `generateMarker.ts:109-114` turns every non-zero exit into a generic message and retries all 3 attempts. Not logged in, quota/rate limit, CLI missing (`ENOENT` spawn-error), and unknown-flag errors are not retryable and should surface an actionable message immediately. Also record a **minimum supported `claude` version** and check it at startup, since the runner depends on `--tools`, `--setting-sources`, `--strict-mcp-config`, and `stream-json` output that can change between CLI releases.
5. **Atomic, versioned data.** `writeMarkers` (`markers.ts:45`), `project.json` writes (`scaffold.ts:57,139,147,162`), and `writeTranscript` (`transcript.ts:29`) use plain `writeFileSync`; a crash mid-write leaves invalid JSON and `readMarkers` (`markers.ts:41`) then throws on every load, bricking the project. Every mutation is also an unlocked read-modify-write, so bulk apply and a user edit can lose changes. Fix: one `writeJsonAtomic` helper (write temp + rename, keep a `.bak`), a per-project mutex around JSON mutations, tolerant reads that fall back to `.bak`, and a **`schemaVersion` in `project.json` with a migration hook** — the moment you ship v1.1, users' existing projects need upgrading.
6. **Packaging-specific breakages found in the code** (these will fail only once installed, so they belong here):
   - Skill MCP servers are launched with `command: 'node'` (`skills.ts:236`). A packaged Electron app has no `node` on PATH; use `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
   - `RUNNER_ROOT`, `TEMPLATES_ROOT`, `SKILLS_ROOT` are computed relative to the source tree (`paths.ts:6-14`); they must resolve to the packaged resources location.
   - Remotion's `bundle()` (`render.ts:30`) runs webpack over real files on disk at export time, so `@remotion/bundler`, `packages/remotion-overlay`, and the Remotion compositor binaries must ship **unpacked** (`asarUnpack`), not inside the asar. Prototype this early — it is the riskiest packaging item.
   - `transcript.ts:40` spawns ffmpeg with `shell: true` on Windows while other call sites don't. Installed data will live under `C:\Users\<name>\AppData\...`, where names with spaces, accents, or `&` are common; drop `shell: true` (argv arrays are already safe) and test with such a profile name.

### P1 — reliability of the core loop

7. **Validate that generated overlays actually render, not just bundle.** `validate.ts` only runs esbuild ("without full TypeScript type-checking", `validate.ts:8`), so runtime errors (undefined access, bad hooks, infinite loops, heavy CPU) pass validation and then white-screen the preview or fail the export. Add a headless `renderStill` smoke test of the first/middle/last frame of the marker with a timeout, and feed its error into the existing retry loop. In the editor, wrap each marker's preview in a React error boundary (none exists today) so one bad marker cannot take down the whole timeline.
8. **Contain AI-generated code.** Generated TSX runs inside the editor page and in headless Chrome. Once the API requires a token, generated code in the same origin could still read it and call the API. Render previews in a sandboxed iframe (or a separate origin without the token) and, in Electron, keep `contextIsolation` on, `nodeIntegration` off, and block navigation/new windows. Keep `WebFetch`/`WebSearch` (`skills.ts:225-227`) and untrusted transcript/image text in mind as prompt-injection inputs; the current "treat text in an image as content" instruction is good, but the confinement to the project directory is what actually protects the user.
9. **Cost and spend visibility.** Bulk apply runs up to 3 attempts per marker (`generateMarker.ts:52`) across N markers, and image generation spends the user's OpenAI money. The CLI's `result` event already carries `total_cost_usd` (logged at `claude.ts:83-90`); show a running session total, ask for confirmation on bulk apply above a threshold, and keep image generation opt-in.
10. **Transcription limits and network resilience** (`transcript.ts`). 64 kbps mono is ~28 MB/hour, so anything longer than ~55 minutes hits the 25 MB cap and fails with "trim the video" (`transcript.ts:74`). Split the audio into chunks with ffmpeg and stitch timestamps instead. Also: no fetch timeout, no retry/backoff on 429/5xx, and whole-file `readFileSync`. Map 401 (bad key), 429 (quota), and network errors to clear messages.
11. **Input validation for uploads.** Video upload filters on client-supplied `mimetype` only (`video.ts:35`). After upload, run `ffprobe` and reject or transcode what the pipeline can't handle (no video stream, exotic codecs, variable frame rate, rotated phone footage), with a clear message. Check free disk space before upload and before render/export (ProRes 4444 output is very large), and delete partial files on aborted uploads or failed renders.
12. **Export you can trust** (`render.ts`, `projects.ts`). Renders are sequential with no progress, no cancel, and no timeout: `renderMedia` supports `onProgress` and a cancel signal, neither of which is used (`render.ts:44`). Stream percent progress over the existing SSE channel, add cancel, cap Chrome concurrency for low-RAM machines, and cache the NVENC probe (`projects.ts:88-95`) rather than re-probing per export. `exportsInFlight` (`projects.ts:152`) and the Claude queue (`claude.ts:9`) live only in memory, so on startup reconcile leftovers: stale temp files (`audio.mp3`, mux `.tmp`), partial outputs, and any marker that was mid-generation.
13. **Editor resilience.** No runner-down/reconnect state (a stopped runner just yields failed fetches), and the SSE streams don't resume. Add a connection banner with auto-retry, and make in-flight operations recoverable after a reload by asking the runner for current job state.
14. **Logs that are safe to send.** Log rotation already exists (`log.ts:46`), but `claude.start` logs up to 6000 characters of prompt (`claude.ts:107`), which contains the user's transcript. Since testers will email you logs, make prompt logging debug-level/opt-in, redact keys defensively, and add an "Export diagnostics" button that zips the logs plus versions of app, `claude`, ffmpeg, and OS.

### P2 — after launch

15. **Tests where breakage hurts most:** atomic JSON helpers, id validation, Claude-error classification, prompt building, marker overlap/timing rules (`markers.ts`, `ranges.ts`), and one end-to-end smoke test in CI that boots the packaged runner against a stub `claude` script.
16. Type-check + lint in CI (`tsc --noEmit` already exists per package; wire it up), dependency audit, and pinned Remotion versions (all `@remotion/*` must match exactly).
17. Optional support for an Anthropic API key as an alternative to the CLI, which would remove the biggest onboarding hurdle for the next, less technical audience.

## 5. Work breakdown

**Phase 0 — Decisions (you, <1 day)**
Platform priority, distribution channel, code-signing budget — see open decisions below; the rest of the plan doesn't block on these being final.

**Phase 1 — Make it a buildable artifact (2–3 days)**
- Compile `apps/runner` (esbuild or `tsc`) instead of shipping raw TS run through `tsx`.
- `vite build` the editor and serve the static bundle from the runner's Express app; collapse the two dev servers into one process/port for the packaged app.
- **Spike the Remotion export from a built, unpacked layout now** (robustness item 6): if `bundle()` can't run from the packaged folder structure, the whole Electron approach needs adjusting, and it is better to learn that before building the rest.
- Robustness P0 items that are pure runner changes and independent of Electron: 2 (id validation), 5 (atomic writes, mutex, `schemaVersion`), 6 (resource paths via a single config module, `process.execPath` for skill servers, drop `shell: true`).

**Phase 2 — Electron shell (3–5 days)**
- New `apps/desktop` package: Electron main process starts the bundled runner (in-process or as a child process) on a free `127.0.0.1` port, opens a `BrowserWindow` pointed at it.
- Robustness P0 item 1: per-launch auth token, no open CORS, relative API base in the editor; `contextIsolation` on, `nodeIntegration` off, navigation blocked.
- Clean shutdown of the runner and all `claude`/ffmpeg/Chrome children on quit (item 3).
- Settings UI (reuse the editor's React stack) for the OpenAI key, backed by `safeStorage`.
- Migrate `PROJECTS_ROOT` to `userData` (per table above).

**Phase 3 — Prerequisite checks / first-run UX + Claude robustness (3–4 days)**
- Build the first-run/settings screen described in the table: Claude CLI detection, OpenAI key validation, encoder status, all with clear remediation actions instead of silent failure.
- Robustness P0 items 3–4: timeout/cancel/stdin prompt, failure classification with non-retryable errors, minimum `claude` version check (feeds directly into the Claude prerequisite screen).

**Phase 3b — Core-loop hardening (4–6 days)**
Robustness P1 items 7–14, in this order of value: overlay render smoke test + editor error boundaries (7), export progress/cancel/startup reconciliation (12), upload validation and disk checks (11), transcription chunking and retries (10), cost visibility (9), editor reconnect (13), safe diagnostics export (14), generated-code containment (8). Items 8 and 13 can slip to a v1.1 if the schedule tightens; 7, 10, 11, and 12 are what testers will hit first.

**Phase 4 — Bundle ffmpeg (1–2 days)**
- Wire `ffmpeg-static`/`ffprobe-static` or platform binaries through `extraResources`.
- Pick an ffmpeg build and check its license obligations (LGPL-only build vs GPL build with x264 — GPL is fine if you ship the required notice, LGPL is lighter-weight if you don't need every codec). This is a real compliance step, not busywork — flag it explicitly rather than skipping it.
- Confirm the Remotion headless-shell pre-fetch from Phase 3's table entry.

**Phase 5 — Packaging & installer (2–4 days, more if macOS signing is pursued)**
- `electron-builder` config: app id/icon, `asar: true`, `extraResources` for ffmpeg, a `files` allowlist so source maps and dev-only files don't ship inside the asar.
- Windows: NSIS target (installer + Start Menu shortcut + uninstaller).
- macOS (fast-follow): dmg target; without a paid Apple Developer cert, Gatekeeper will block it — document the "right-click → Open" workaround for v1 rather than paying for notarization up front.
- GitHub Actions workflow (none exists today) to build on tag push and attach installers to a release.
- **Distribution nuance to resolve now, not later:** GitHub only lets *anonymous* people download Release assets from a **public** repo. If this repo stays private, a shareable link that doesn't require the recipient to have GitHub access to your repo means either (a) a separate public "releases-only" repo you push built installers to (no source in it), or (b) hosting the installer elsewhere entirely — itch.io (free, versioned, built for exactly this) or your own site/cloud storage link. Recommend (a) or itch.io over a raw file-sharing link, since both give you versioning for free.
- Unsigned installers will show a Windows SmartScreen "unknown publisher" warning. Acceptable for a free technical-preview audience, but put a one-line heads-up on the download page ("Windows will warn this is unsigned — More Info → Run Anyway") so people aren't scared off on first contact.

**Phase 6 — Ship-quality bar (2–3 days)**
- Smoke test on a clean machine/VM without Claude CLI, ffmpeg, or Node pre-installed: confirm the prereq screens actually trigger, then run the full happy path (import → transcribe → plan markers → generate overlay → export).
- Failure drills, since the point of this phase is robustness: unplug the network mid-transcribe, kill `claude` mid-generation, kill the app mid-export, fill the disk, sign out of the CLI, use a Windows profile name with spaces/accents, upload a phone (rotated, HEVC) video, and open a project after force-quitting during a save. Each should end in a clear message or automatic recovery, never a hang or a corrupt project.
- Add the P2 minimum: unit tests for the atomic-write, id-validation, and error-classification helpers, and a CI job that type-checks and builds.
- Bump and display a version number in the app so bug reports are attributable.

**Phase 7 — Explicitly out of scope for v1** (revisit only if this gets traction): auto-update, macOS notarization/code signing, Linux target, crash reporting, licensing/payment gate, the broader P2 test suite, and Anthropic-API-key support.

## 6. Rough timeline

~3–4 weeks of focused solo work for a Windows-first technical preview (roughly 1 week of that is the robustness work in Phases 1, 3, 3b, and 6); add about another week if macOS ships in the same v1 rather than as a fast-follow. If you need to cut scope, cut robustness items 8 and 13 first and never the P0 tier.

## 7. Open decisions

- **Platforms for v1:** Windows only (matches your dev machine, fastest to ship) vs. Windows+macOS together?
- **Distribution channel:** public releases-only repo, itch.io, or your own hosted link?
- **Code signing budget for v1:** $0 and accept SmartScreen/Gatekeeper warnings, or buy a cert now (~$100–400/yr)?
- **ffmpeg license posture:** GPL build (full codec support, must ship notice) or LGPL-only build (lighter compliance, narrower codec support)?

None of these block starting Phase 1–4; they only need answers before Phase 5 (packaging/distribution).
