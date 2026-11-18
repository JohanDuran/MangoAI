# MangoAI in the video-studio ecosystem

MangoAI is one of three repos released together. The full picture, the compatibility table and the release order
are in [video-studio's ECOSYSTEM.md](https://github.com/JohanDuran/video-studio/blob/main/ECOSYSTEM.md); this page lists
what touches MangoAI.

| Repo | Role |
|---|---|
| [video-studio](https://github.com/JohanDuran/video-studio) | The plugin and front door. **Registers MangoAI** (MCP server + hook) and pins its version |
| [media-toolbox](https://github.com/JohanDuran/media-toolbox) | Makes media in Docker. MangoAI's Toolbox tab calls it |
| **MangoAI** (this repo) | Edits and renders |

## What others rely on here (change with care)

- **MCP tools** (`packages/mcp/src/main.ts`): names, parameters, results and the server instructions. The video-studio
  skills call them by name. Renaming or removing a tool needs a skill update in the same release.
- **CLI** (`packages/cli/src/bin.mjs`): `mangoai mcp`, `mangoai start`, `mangoai version`. The plugin's
  `tools/mangoai-launch.mjs` runs `npx --package=<tarball> mangoai mcp`.
- **Package and release**: the npm name `mangoai` and the tarball `mangoai-<v>.tgz` on GitHub release `v<v>`
  (`.github/workflows/release.yml`). The plugin's `versions.json` points at that URL.
- **The hook** (`packages/mcp/hook.mjs`) and the files it reads (`~/.mangoai/projects.json`,
  `<project>/.mangoai/claude.json`). The plugin ships a **copy** in `hooks/mangoai-hook.mjs`; its CI fails until the copy
  matches the pinned version.
- **Health**: `GET /api/health` → `{app: "mangoai", version}` on port 4780. `/studio-setup` compares the version.
- **`MANGOAI_REPO`**: when set, the plugin launcher and `bin.mjs` run this clone's sources (`packages/mcp/src/main.ts`,
  `packages/server/src/main.ts`). Keep those paths, or update the launcher too.

## What MangoAI relies on elsewhere

- **media-toolbox REST API** (`packages/server/src/toolbox.ts`): `/api/state`, `/api/jobs`, `/api/jobs/{id}/wait`,
  `/api/library`, `/api/library/mark` at `http://127.0.0.1:8765` (`MANGO_TOOLBOX_URL`).
- **The `short.json` format** owned by media-toolbox (`docs/short-spec.md`): the lossless importer/exporter in
  `packages/core/src/import/shortJson.ts` follows it.
- **The studio pointer** `~/.video-studio/config.json` (`studio`), written by `/studio-setup`.

## Releasing MangoAI

Bump `packages/core/src/version.ts` and `packages/cli/package.json` together (`npm run build` refuses a mismatch), push
tag `vX.Y.Z`. Then bump `versions.json` in video-studio (and copy the hook if it changed). Developers who use the
plugin and work on this repo: set `MANGOAI_REPO` to the clone instead of `npm run claude-setup`, or Claude sees every
tool twice.
