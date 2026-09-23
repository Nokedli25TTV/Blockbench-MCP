#!/usr/bin/env node
// Print the GitHub Release notes for a version:  node tools/release-notes.mjs 0.3.1
// (or "Unreleased" to preview). Fork notice + downloads + that version's CHANGELOG section.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { section } from "./changelog.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) {
  console.error("Usage: node tools/release-notes.mjs <version|Unreleased>");
  process.exit(1);
}
const body = section(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
if (!body) {
  console.error(`CHANGELOG.md has no section for "${version}".`);
  process.exit(1);
}
const zipName = /^\d/.test(version) ? `blockbench-mcp-${version}.zip` : "blockbench-mcp-<version>.zip";

console.log(`> Personal, non-profit, AI-assisted fork of [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp) (original author enfpdev); many tool definitions ported from [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project). Use at your own risk — see the README.

## Downloads

- **\`${zipName}\`** — ready to run, no build needed: the server bundle (\`apps/mcp-server/dist/index.js\`, no \`node_modules\` required), the plugin, the skill guides, README, CHANGELOG and LICENSE. Unzip anywhere; the paths match the README's install steps.
- **\`mcp_socketio_plugin.js\`** — the Blockbench plugin alone (File → Plugins → Load Plugin from File).

Requires Node.js 18+ and the Blockbench 5 desktop app. After upgrading, fully restart every AI client that runs this server and reload the plugin in Blockbench (File → Plugins); \`get_project_info\` should then show \`plugin_build\` and \`mcp_bridge.server_version\` for this version.

## Changes

${body}`);
