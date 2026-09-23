// Helpers for CHANGELOG.md (Keep a Changelog layout: "## [Unreleased]", "## [0.3.1] - 2026-09-30", …).
// A section runs from its "## " heading to the next "## " heading or the end of the file.

const isHeading = (line) => /^## /.test(line);
const headingOf = (name) => (line) => new RegExp(`^## \\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i").test(line);

/** Body of the section for `name` ("Unreleased" or a version), trimmed; null if missing. */
export function section(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(headingOf(name));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && isHeading(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Move the Unreleased notes under a new "## [version] - date" heading; leaves Unreleased empty. */
export function releaseUnreleased(text, version, date) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(headingOf("Unreleased"));
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  if (lines.some(headingOf(version))) throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  let end = lines.findIndex((l, i) => i > start && isHeading(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) throw new Error("The Unreleased section of CHANGELOG.md is empty — write down what changed first.");
  const out = [...lines.slice(0, start), "## [Unreleased]", "", `## [${version}] - ${date}`, "", body, "", ...lines.slice(end)];
  return { text: out.join("\n"), notes: body };
}
