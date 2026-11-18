# MangoAI: notes for Claude

**This repo is one of three that work together** (video-studio plugin, media-toolbox, MangoAI). Before changing an MCP
tool, the `mangoai` CLI, the hook, `/api/health`, the release tarball, the short.json importer/exporter or the calls to
the toolbox, read [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md): those are contracts the other repos depend on. Say in the
PR which other repo needs a matching change, and don't remove or rename a tool without that change.

- Version: `packages/core/src/version.ts` and `packages/cli/package.json` move together; a release is a `vX.Y.Z` tag.
- Checks: `npm run typecheck`, `npm test`, `npm run build` (builds the publishable package in `packages/cli/dist`).
- The editor runs from source with `npm start` (Vite dev mode), or from the package with `npx mangoai start`.
