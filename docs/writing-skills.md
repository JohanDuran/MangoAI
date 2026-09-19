# Writing a MangoAI skill

A skill teaches Claude how to do one more thing while it designs an overlay: play a sound,
generate an image, use a component library, follow a brand style. Claude sees each enabled
skill's name and description, and loads the full instructions only when a skill matches what
the animation needs, so you can have many skills without bloating every request.

Skills live in folders. The built-in ones are in [`skills/`](../skills). Copy one and edit it.

## Folder layout

```
skills/my-skill/
  skill.json      required. Machine-readable settings for the runner.
  SKILL.md        required. What Claude reads. Frontmatter + instructions.
  server.mjs      optional. An MCP server that gives Claude tools.
  public/         optional. Static files served over HTTP (sounds, fonts, images).
  catalog.json    optional. Any extra file listed in "files" below.
```

The folder name must equal the skill `name`: lowercase words joined by hyphens.

## SKILL.md

```markdown
---
name: my-skill
description: One or two sentences saying what this does and when to use it.
---

# Instructions for Claude
...
```

The `description` is the only part Claude sees up front. It decides whether the skill is
loaded, so say what the skill provides and the situations that call for it. Write the body as
direct instructions: which files to read, which tools to call, which URLs are allowed, what
to avoid.

The text `{{SKILL_URL}}` in `SKILL.md` is replaced with the URL that serves your `public/`
folder, for example `http://localhost:5175/skills/my-skill/public`. Use it so generated code
can load your files, both in the browser preview and in the final render.

## skill.json

```json
{
  "schemaVersion": 1,
  "name": "my-skill",
  "optIn": false,
  "env": ["MY_API_KEY"],
  "packages": ["some-npm-package"],
  "files": ["catalog.json"],
  "mcp": { "server": "server.mjs", "tools": ["do_thing"] }
}
```

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | yes | Must be `1`. The runner refuses skills with a version it does not know. |
| `name` | yes | Same as the folder name and the `SKILL.md` frontmatter name. |
| `optIn` | no | If `true`, the skill is only given to Claude when the request asks for it (the editor's checkbox). Use it for anything that costs money or takes long. |
| `env` | no | Environment variables the skill needs, usually API keys. If one is missing the skill is skipped and the run continues without it. Only the skill's MCP server receives these, and only while the skill is active. |
| `packages` | no | npm packages generated marker code may import besides `react` and `remotion`. They must already be installed for the project. |
| `files` | no | Extra files copied next to `SKILL.md` in every project, so Claude can read them (a catalog, a style guide). Keep them small. |
| `mcp` | no | An MCP server and the exact tool names it exposes. Only listed tools are allowed. |

## What kind of skill?

- **Instructions only** (a motion style, a brand guide): just `SKILL.md`.
- **Static files** (sound effects, textures): put them in `public/`, describe them in a catalog
  file, and have `SKILL.md` tell Claude how to reference them.
- **Tools** (image generation, data lookups, text to speech): add an MCP server.
- **A code library**: list the package in `packages` and document its API in `SKILL.md`.

## Writing an MCP server

The runner starts your server with `node <server file>` for each Claude call that uses the
skill, and speaks the standard [MCP](https://modelcontextprotocol.io) stdio protocol. It sets:

| Variable | Value |
|---|---|
| `MANGOAI_PROJECT_DIR` | Absolute path of the current project. Write generated files under it, for example `02_assets/`. |
| `MANGOAI_RUNNER_URL` | Base URL of the runner. Files in `02_assets/` are served at `<url>/projects/<projectId>/assets/<file>`. |
| the keys in `env` | Their values. |

Return a URL to Claude and let it use the URL in the marker code. See
[`skills/image-generation/server.mjs`](../skills/image-generation/server.mjs) for a complete
server with no dependencies. Return errors as tool results with `isError: true` and a short
message, so Claude can fall back gracefully.

## Try it

1. Put your skill folder in `skills/` (or in any folder listed in `MANGOAI_SKILLS_DIRS`, a
   `;`-separated list on Windows and `:`-separated elsewhere).
2. Restart the runner and open `GET /skills`. Your skill appears with any `problems` (a bad
   manifest is reported with the reason and skipped, it does not stop the runner).
3. Generate a marker whose prompt should trigger it. In the runner logs, or the `init` event
   of the Claude stream, check that the skill and its tools are listed. The generated code is
   kept in `05_debug/code_history/`.

Claude decides for itself whether a skill fits. If it does not load yours, sharpen the
`description`.

## Enabling skills per project

Each project has a `skills` list in `project.json`. New projects get the built-in skills.
Skills from `MANGOAI_SKILLS_DIRS` are never enabled automatically: enable them for a project
with `PUT /projects/:id/skills` and body `{ "enabled": ["name", ...] }`.

## Trust and security

**A skill with an MCP server runs code on your machine. Only enable skills you trust.**

What the runner enforces for every Claude call:

- Claude has no shell. Its tools are Read, Write, Edit, Glob, Grep, Skill and the MCP tools
  of active skills, and the file tools only reach the project directory.
- Each MCP tool must be listed in `skill.json`. Anything else is refused.
- A skill's secrets are removed from Claude's environment unless that skill is active.
- Skill files are validated: names must match, and `files` and `mcp.server` may not point
  outside the skill folder.

What skills cannot do: change how the final video is rendered or mixed. Adding a new kind of
media (for example a background music track that is mixed differently) needs a change in the
runner, not just a skill.
