import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Loads the Blockbench skill guides shipped in <repo>/skills and exposes them to
// the MCP client: a concise index goes into the server `instructions` (injected on
// every startup), and the full SKILL.md (plus references/assets) is fetchable via
// the get_skill tool / skill:// resources.

export interface SkillInfo {
  name: string; // frontmatter name (falls back to directory name)
  dir: string; // directory name under skills/
  description: string; // frontmatter description (full)
  file: string; // absolute path to SKILL.md
  extraFiles: string[]; // other files in the skill dir, relative (references/…, assets/…)
}

export interface LoadedSkills {
  dir: string | null;
  skills: SkillInfo[];
}

function resolveSkillsDir(): string | null {
  const candidates = [
    process.env.BLOCKBENCH_SKILLS_DIR,
    // dist/index.js -> apps/mcp-server/dist -> repo root/skills
    path.join(__dirname, "..", "..", "..", "skills"),
    // when run from source (ts-node) -> apps/mcp-server/src -> repo root/skills
    path.join(__dirname, "..", "..", "skills"),
    path.join(process.cwd(), "skills"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return path.resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const body = m[1];
  const strip = (s?: string) => s?.trim().replace(/^["']|["']$/g, "");
  return {
    name: strip(body.match(/^name:\s*(.+)$/m)?.[1]),
    description: strip(body.match(/^description:\s*(.+)$/m)?.[1]),
  };
}

function listFilesRecursive(root: string, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

export function loadSkills(): LoadedSkills {
  const dir = resolveSkillsDir();
  if (!dir) return { dir: null, skills: [] };

  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(dir)) {
    const sub = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      continue;
    }
    const file = path.join(sub, "SKILL.md");
    if (!isDir || !existsSync(file)) continue;

    const md = readFileSync(file, "utf8");
    const fm = parseFrontmatter(md);
    const extraFiles = listFilesRecursive(sub).filter((f) => f !== "SKILL.md");
    skills.push({
      name: fm.name || entry,
      dir: entry,
      description: fm.description || "",
      file,
      extraFiles,
    });
  }

  // Stable, intentional order: orchestrator and overview first, dev last.
  const priority = ["blockbench-use", "blockbench-mcp-overview"];
  const last = ["blockbench-development", "blockbench-plugins"];
  skills.sort((a, b) => {
    const rank = (s: SkillInfo) =>
      priority.includes(s.dir) ? priority.indexOf(s.dir) : last.includes(s.name) || last.includes(s.dir) ? 100 : 50;
    return rank(a) - rank(b) || a.dir.localeCompare(b.dir);
  });

  return { dir, skills };
}

const firstSentence = (text: string, max = 240): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  const dot = clean.indexOf(". ");
  const cut = dot > 0 && dot < max ? dot + 1 : Math.min(clean.length, max);
  return clean.slice(0, cut) + (cut < clean.length ? " …" : "");
};

export function buildInstructions(loaded: LoadedSkills): string {
  if (loaded.skills.length === 0) return "";
  const lines = [
    "Blockbench skill guides are bundled with this server and MUST be consulted before you create, modify, texture, animate, or export Blockbench content.",
    "Workflow: call the `get_skill` tool to read the relevant guide(s) BEFORE the corresponding tool calls. Always read `blockbench-use` first (the mandatory orchestrator), then the domain skill(s).",
    "Loading order: 1) blockbench-use  2) blockbench-mcp-overview  3) domain skill(s) — modeling / texturing / pbr-materials / animation / hytale  4) blockbench-development (only when authoring a Blockbench plugin).",
    "",
    "Available skills (use the name with get_skill):",
    ...loaded.skills.map((s) => `- ${s.name}: ${firstSentence(s.description)}`),
  ];
  return lines.join("\n");
}

/** Read a skill's SKILL.md, or a specific reference/asset file within the skill dir. */
export function getSkillContent(
  loaded: LoadedSkills,
  name: string,
  file?: string
): { ok: true; path: string; text: string } | { ok: false; error: string } {
  const skill = loaded.skills.find((s) => s.name === name || s.dir === name);
  if (!skill) {
    return { ok: false, error: `Unknown skill "${name}". Available: ${loaded.skills.map((s) => s.name).join(", ")}.` };
  }
  const skillDir = path.dirname(skill.file);

  let target = skill.file;
  if (file) {
    // Resolve within the skill directory and prevent path traversal.
    const resolved = path.resolve(skillDir, file);
    if (resolved !== skillDir && !resolved.startsWith(skillDir + path.sep)) {
      return { ok: false, error: `File "${file}" is outside the skill directory.` };
    }
    if (!existsSync(resolved)) {
      return { ok: false, error: `File "${file}" not found in skill "${skill.name}". Available: ${skill.extraFiles.join(", ") || "(none)"}.` };
    }
    target = resolved;
  }

  let text = readFileSync(target, "utf8");
  if (!file && skill.extraFiles.length) {
    text += `\n\n---\nAdditional files in this skill (fetch with get_skill name="${skill.name}" file="<path>"):\n` +
      skill.extraFiles.map((f) => `- ${f}`).join("\n");
  }
  return { ok: true, path: target, text };
}
