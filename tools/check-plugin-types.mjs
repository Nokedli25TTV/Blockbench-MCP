#!/usr/bin/env node
// Typecheck the Blockbench plugin against a ratchet. The plugin has known errors that
// come from outdated blockbench-types (APIs that exist at runtime but not in the
// typings), so a clean `tsc` is not possible yet. This fails only when the count
// goes UP — a new type error — and asks to lower BASELINE when it goes down.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE = 56;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "apps", "mcp-plugin");
const tsc = createRequire(path.join(pluginDir, "package.json")).resolve("typescript/bin/tsc");
const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", pluginDir], { encoding: "utf8" });
const out = `${r.stdout}${r.stderr}`;
const errors = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));

if (errors.length > BASELINE) {
  console.error(out);
  console.error(`Plugin typecheck: ${errors.length} errors, baseline ${BASELINE} — a change added ${errors.length - BASELINE} new type error(s).`);
  process.exit(1);
}
if (errors.length < BASELINE) {
  console.log(`Plugin typecheck: ${errors.length} errors (baseline ${BASELINE}) — fewer than before; lower BASELINE in tools/check-plugin-types.mjs.`);
} else {
  console.log(`Plugin typecheck: ${errors.length} known errors (baseline ${BASELINE}), no new ones.`);
}
