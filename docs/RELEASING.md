# Releasing MangoAI

How the Windows installer is built, tested and shared while the source stays private.

## What ships

One file: `MangoAI-Setup-<version>.exe` (an NSIS installer, per-user, no administrator rights, about 270 MB). Installed it
holds Electron, the bundled runner and editor, Remotion with its Chrome Headless Shell, and a pinned FFmpeg build
(GPL v3, hash-checked in `scripts/build-runtime.mjs`). Users provide the Claude Code CLI and, optionally, an OpenAI key.

## Build locally

```powershell
npm install
npm run runtime      # stages build/runtime (downloads Chrome Headless Shell and ffmpeg the first time)
npm test             # unit + failure-drill tests (ffmpeg-dependent tests need the staged runtime)
npm run dist         # writes release/MangoAI-Setup-<version>.exe
```

Notes:

- Run these from a normal terminal. If `ELECTRON_RUN_AS_NODE` is set (VS Code's integrated terminal and some tools set
  it), Electron starts as plain Node and `electron`/`electron-builder` fail: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- `npm run desktop:dev` starts the desktop shell from the staged runtime (rebuild it with `npm run runtime` after changing
  runner or editor code). For day-to-day development keep using `npm run dev:runner` and `npm run dev:editor`.
- The packaged app can be smoke-tested at any time: `MangoAI.exe --smoke-test` opens the UI, creates a project, checks the
  overlay preview, runs a real export and exits 0 on success (`--no-export` skips the export). Set `MANGO_PROJECTS_DIR` to
  keep the test project out of your real projects folder.
- Always smoke-test an installed copy outside the repository. Inside it, Node can find the repository's own
  `node_modules` and hide a missing file in the package.

## Cut a release

1. Make sure `main` is green (CI type-checks, builds the editor and runs the tests).
2. `git tag v0.1.0 && git push origin v0.1.0`.
3. The **Release** workflow builds on `windows-latest`: type-check, `npm run runtime`, full tests, installer, a silent install
   into a temp folder plus `--smoke-test` of the installed app, SHA-256 sums, and uploads them as a workflow artifact.
4. If the publishing variables below are set, it also creates a **pre-release** in the public releases repository with the
   installer and `SHA256SUMS.txt`. Otherwise download the artifact and upload it yourself.

### One-time setup of the public releases repository

GitHub only lets people who are not signed in download release files from a **public** repository, so the installers live in
a separate public repository that contains no source:

1. Create a public repo, for example `<you>/mangoai-releases`. Copy `docs/releases-repo/README.md` into it as `README.md`.
   Turn on Issues (testers report problems there).
2. Create a fine-grained personal access token limited to that repository with **Contents: Read and write**.
3. In the private source repo: Settings -> Secrets and variables -> Actions: add the secret `RELEASES_REPO_TOKEN` (the token) and
   the variable `RELEASES_REPO` (`<you>/mangoai-releases`).
4. Share `https://github.com/<you>/mangoai-releases/releases/latest`. Edit the pre-release notes and mark it as the latest
   release when you are happy with it.

## Before the first public link

- Read `apps/desktop/build/license.txt` (a draft written for this preview) and change it to what you actually want.
- Read the Remotion license (https://www.remotion.dev/license). It is free for individuals and companies of up to three people;
  a company with more people that uses MangoAI to make videos may need its own Remotion license. The README, the license page and
  `THIRD-PARTY-NOTICES.txt` say so; decide if that is the message you want.
- The FFmpeg build is GPL v3 and ships as a separate program with its notice and a source link (`bin/FFMPEG-NOTICE.txt`). Keep
  those files if you change the ffmpeg version.
- Install and uninstall the released file once on a clean Windows user account or VM without Claude Code, ffmpeg or Node.
  Expected: installer shows a heads-up about the Claude CLI, the app opens the requirements panel on first start.

## Code signing (later)

Unsigned installers show a SmartScreen "unknown publisher" notice. When you buy a certificate, set `CSC_LINK` and
`CSC_KEY_PASSWORD` (or use Azure Trusted Signing) in the workflow environment; electron-builder signs automatically. Nothing else
changes.

## Updating users

There is no auto-update in this preview. A new version is a new installer; installing over the old one keeps projects (they live in
`%APPDATA%\MangoAI`) and upgrades project files through the migration steps in `apps/runner/src/lib/migrate.ts`. When you change
the on-disk layout, bump `CURRENT_SCHEMA_VERSION` in `scaffold.ts` and add a step there.
