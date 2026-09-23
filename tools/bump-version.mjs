#!/usr/bin/env node
// Cut a release locally:  pnpm bump patch|minor|major [--dry-run]   (or an exact x.y.z)
//
// 1. checks the working tree is clean and all package.json versions agree,
// 2. computes the next version (a higher part resets the lower ones: 0.3.2 → minor → 0.4.0),
// 3. moves CHANGELOG.md's Unreleased notes under the new version,
// 4. writes the version into every package.json, commits "Release vX.Y.Z" and tags vX.Y.Z.
// Nothing is pushed. Pushing the tag starts .github/workflows/release.yml, which builds,
// tests and drafts the GitHub Release from the changelog.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseUnreleased } from "./changelog.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["package.json", "apps/mcp-server/package.json", "apps/mcp-plugin/package.json", "packages/shared/package.json"];
const fail = (msg) => { console.error(msg); process.exit(1); };
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout.trim();
};

const args = process.argv.slice(2).filter((a) => a !== "--");
const dryRun = args.includes("--dry-run");
const kind = args.find((a) => !a.startsWith("--"));
if (!kind) fail("Usage: pnpm bump patch|minor|major|<x.y.z> [--dry-run]");

const versions = PACKAGES.map((p) => [p, JSON.parse(readFileSync(path.join(root, p), "utf8")).version]);
const current = versions[0][1];
if (versions.some(([, v]) => v !== current)) fail(`The package.json versions differ — fix them first:\n${versions.map(([p, v]) => `  ${p}: ${v}`).join("\n")}`);
const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) || []).slice(1).map(Number);
const [major, minor, patch] = parse(current);
if (major === undefined) fail(`The current version "${current}" is not x.y.z.`);

let next;
if (kind === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (kind === "minor") next = `${major}.${minor + 1}.0`;
else if (kind === "major") next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(kind)) next = kind;
else fail(`Unknown bump "${kind}". Use patch, minor, major or an exact x.y.z.`);
const higher = parse(next).reduce((d, n, i) => d || n - parse(current)[i], 0) > 0;
if (!higher) fail(`${next} is not higher than the current ${current}.`);

if (!dryRun && git("status", "--porcelain")) fail("The working tree has uncommitted changes — commit or stash them first.");
if (git("tag", "--list", `v${next}`)) fail(`Tag v${next} already exists.`);

const changelogPath = path.join(root, "CHANGELOG.md");
const today = new Date().toISOString().slice(0, 10);
let released;
try {
  released = releaseUnreleased(readFileSync(changelogPath, "utf8"), next, today);
} catch (e) {
  fail(e.message);
}

console.log(`${current} → ${next} (${kind})\n\nRelease notes (from CHANGELOG.md):\n\n${released.notes}\n`);
if (dryRun) {
  console.log("--dry-run: nothing was written.");
  process.exit(0);
}

for (const p of PACKAGES) {
  const file = path.join(root, p);
  // Replace only the version value, so the file's formatting stays as it is.
  writeFileSync(file, readFileSync(file, "utf8").replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));
}
writeFileSync(changelogPath, released.text);
git("add", ...PACKAGES, "CHANGELOG.md");
git("commit", "-m", `Release v${next}`);
git("tag", "-a", `v${next}`, "-m", `v${next}`);

const remotes = git("remote").split(/\s+/);
const remote = remotes.includes("github") ? "github" : remotes[0] || "origin";
console.log(`Committed "Release v${next}" and tagged v${next}. Nothing is pushed yet.

To publish, push the commit and the tag:
  git push ${remote} HEAD:main --follow-tags
The Release workflow then builds, tests and drafts the GitHub Release — review it on GitHub and press Publish.
To undo before pushing:  git tag -d v${next} && git reset --hard HEAD~1`);
