import type { Vec3 } from "./types";

// Where rotation may go in the open project, and within which limits. Derived from
// Blockbench's own format flags — `bone_rig` (groups carry an exported rotation) and
// `rotate_cubes` (cubes may rotate) — plus what each Minecraft Java block-model
// version accepts. Measured on Blockbench 5.2.1 (2026-09-23) by exporting a cube
// rotated [10,30,0]: see MODELING_CONSTRAINTS.md rule 1.
// Used by the plugin (tool checks), the server (validate_model) and the test mock.

export interface FormatInfo {
  id?: string | null;
  bone_rig?: boolean;
  rotate_cubes?: boolean;
  /** Blockbench's Java block-model target: "1.9.0" | "1.21.6" | "1.21.11" | "26.3". */
  java_block_version?: string | null;
  coordinate_limits?: [number, number] | null;
}

export interface RotationRule {
  allowed: boolean;
  maxAxes: 1 | 3;
  /** The only angles the target accepts, when restricted (Java 1.9–1.21.5). */
  angles?: number[];
  /** What to do instead, shown when a rotation is refused. */
  hint?: string;
}

export interface FormatRules {
  format: string;
  bone: RotationRule;
  cube: RotationRule;
  coordinateLimits: [number, number] | null;
  summary: string;
}

export const JAVA_CLASSIC_ANGLES = [-45, -22.5, 0, 22.5, 45];

const JAVA_RANGES: Record<string, string> = {
  "1.9.0": "Minecraft 1.9–1.21.5",
  "1.21.6": "Minecraft 1.21.6–1.21.10",
  "1.21.11": "Minecraft 1.21.11–26.2",
  "26.3": "Minecraft 26.3+",
};

const versionParts = (v: string): number[] | null => {
  const m = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
const before = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/** Blockbench's java_block_version for a Minecraft Java version: "1.20.1" → "1.9.0". */
export function javaBlockVersionFor(minecraftVersion: string): string | null {
  const v = versionParts(minecraftVersion);
  if (!v) return null;
  if (before(v, [1, 21, 6])) return "1.9.0";
  if (before(v, [1, 21, 11])) return "1.21.6";
  if (before(v, [26, 3, 0])) return "1.21.11";
  return "26.3";
}

export function javaVersionLabel(javaBlockVersion: string | null | undefined): string {
  return JAVA_RANGES[javaBlockVersion || ""] || `java_block_version ${javaBlockVersion}`;
}

const describe = (r: RotationRule): string =>
  !r.allowed ? "no rotation"
    : r.angles ? `one axis, only ${r.angles.join("/")}°`
    : r.maxAxes === 1 ? "one axis, any angle" : "any axes";

export function rulesFor(f?: FormatInfo | null): FormatRules {
  const id = (f && f.id) || "unknown";

  // Format flags unknown (an older plugin, or a test without a format): keep the
  // original strict rule — groups rotate on one axis, cubes never.
  if (!f || f.bone_rig === undefined || f.rotate_cubes === undefined) {
    const bone: RotationRule = { allowed: true, maxAxes: 1, hint: "nest groups for multi-axis rotation (rule #1)" };
    const cube: RotationRule = { allowed: false, maxAxes: 1, hint: "rotate a parent group instead (rule #1)" };
    return { format: id, bone, cube, coordinateLimits: f?.coordinate_limits ?? null, summary: `${id}: groups ${describe(bone)} (nest groups for more); cubes ${describe(cube)}.` };
  }

  if (id === "java_block") {
    // Java block/item JSON has no bones: group rotation only lives in Blockbench's
    // own metadata and never reaches the game, so rotation belongs on the cube.
    const version = f.java_block_version || "1.9.0";
    const cube: RotationRule =
      version === "1.9.0" ? { allowed: true, maxAxes: 1, angles: JAVA_CLASSIC_ANGLES, hint: "Minecraft 1.9–1.21.5 accepts one axis at -45/-22.5/0/22.5/45° per element" }
      : version === "1.21.6" ? { allowed: true, maxAxes: 1, hint: "Minecraft 1.21.6–1.21.10 accepts one axis per element" }
      : { allowed: true, maxAxes: 3 };
    const bone: RotationRule = { allowed: false, maxAxes: 1, hint: "Java block/item models export no group rotation, so rotate the cube itself (set_rotation with the cube's name)" };
    const limits = f.coordinate_limits ?? [-16, 32];
    return {
      format: id,
      bone,
      cube,
      coordinateLimits: limits,
      summary: `java_block (${javaVersionLabel(version)}): cubes rotate on ${describe(cube)}; groups don't export rotation; coordinates ${limits[0]}..${limits[1]}.`,
    };
  }

  const bone: RotationRule = f.bone_rig ? { allowed: true, maxAxes: 3 } : { allowed: false, maxAxes: 1, hint: "this format has no bone rotation" };
  const cube: RotationRule = f.rotate_cubes ? { allowed: true, maxAxes: 3 } : { allowed: false, maxAxes: 1, hint: "this format cannot rotate cubes — rotate a parent bone" };
  const note = bone.allowed && cube.allowed ? " (static cube rotation is fine; anything that animates needs its own bone)" : "";
  return {
    format: id,
    bone,
    cube,
    coordinateLimits: f.coordinate_limits ?? null,
    summary: `${id}: bones ${describe(bone)}; cubes ${describe(cube)}${note}.`,
  };
}

const EPS = 1e-6;

/** Why `rotation` is not allowed for this target, or null when it is. [0,0,0] is always fine. */
export function checkRotation(rule: RotationRule, rotation: Vec3, label: string): string | null {
  const used = rotation.filter((n) => Math.abs(n) > EPS);
  if (!used.length) return null;
  if (!rule.allowed) return `${label}: rotation not allowed here — ${rule.hint}.`;
  if (used.length > rule.maxAxes) {
    return `${label}: rotation uses ${used.length} axes, but this project allows ${rule.maxAxes === 1 ? "one" : rule.maxAxes} per element${rule.hint ? ` — ${rule.hint}` : ""}.`;
  }
  if (rule.angles) {
    const bad = used.find((n) => !rule.angles!.some((a) => Math.abs(a - n) < EPS));
    if (bad !== undefined) return `${label}: ${bad}° is not accepted — ${rule.hint}.`;
  }
  return null;
}

/** Why the box leaves the format's coordinate range, or null when it fits. */
export function checkBounds(rules: FormatRules, from: Vec3, to: Vec3, label: string): string | null {
  const lim = rules.coordinateLimits;
  if (!lim) return null;
  const out = [...from, ...to].some((n) => n < lim[0] - EPS || n > lim[1] + EPS);
  return out ? `${label} [${from.join(",")}]→[${to.join(",")}] leaves the ${lim[0]}..${lim[1]} range this format allows.` : null;
}
