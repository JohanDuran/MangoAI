/**
 * MangoAI's version. One number for the editor, its server, the MCP server and the published `mangoai` npm
 * package (packages/cli/package.json must match; `npm run build` checks).
 * The video-studio plugin pins this version in its .mcp.json, so bumping it is a release step across repos:
 * see docs/ECOSYSTEM.md.
 */
export const VERSION = '0.3.1';
