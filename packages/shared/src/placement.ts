// Pure geometry behind the placement tools: move_element, place_relative, the pivot
// anchors of set_origin and the mirrored copies of duplicate_element.
//
// Blockbench keeps every coordinate in model space and rotates at render time: an element
// about its own origin, then each ancestor group about the group's origin, every rotation
// with Euler order ZYX (X first, then Y, then Z; checked live on Blockbench 5.2.1). The
// plugin builds a GeoNode tree from Blockbench's elements and the test mock from its own
// scene, so the same math runs in both and is unit-tested without Blockbench.
import type { Vec3 } from "./types";

export interface Box { min: Vec3; max: Vec3 }
/** One rotation in the chain above a node: degrees (Euler ZYX) about an origin. */
export interface Frame { origin: Vec3; rotation: Vec3 }
export interface GeoNode {
  name: string;
  /** "point" = any other element, given as its points in model space (mesh vertices, a locator). */
  kind: "group" | "cube" | "point";
  origin: Vec3;
  rotation: Vec3;
  from?: Vec3;
  to?: Vec3;
  inflate?: number;
  points?: Vec3[];
  children?: GeoNode[];
}

const RAD = Math.PI / 180;

/** Rotate `p` about `origin` by Euler angles in degrees, order ZYX (X first, then Y, then Z). */
export function rotateAbout(p: Vec3, origin: Vec3, rot: Vec3): Vec3 {
  if (!rot[0] && !rot[1] && !rot[2]) return [p[0], p[1], p[2]];
  let x = p[0] - origin[0], y = p[1] - origin[1], z = p[2] - origin[2], t: number;
  const a = rot[0] * RAD, b = rot[1] * RAD, c = rot[2] * RAD;
  t = y * Math.cos(a) - z * Math.sin(a); z = y * Math.sin(a) + z * Math.cos(a); y = t;
  t = x * Math.cos(b) + z * Math.sin(b); z = -x * Math.sin(b) + z * Math.cos(b); x = t;
  t = x * Math.cos(c) - y * Math.sin(c); y = x * Math.sin(c) + y * Math.cos(c); x = t;
  return [x + origin[0], y + origin[1], z + origin[2]];
}

/** Undo a rotation on a direction (no origin): Z back first, then Y, then X. */
export function unrotateVector(v: Vec3, rot: Vec3): Vec3 {
  let [x, y, z] = v, t: number;
  const a = -rot[0] * RAD, b = -rot[1] * RAD, c = -rot[2] * RAD;
  t = x * Math.cos(c) - y * Math.sin(c); y = x * Math.sin(c) + y * Math.cos(c); x = t;
  t = x * Math.cos(b) + z * Math.sin(b); z = -x * Math.sin(b) + z * Math.cos(b); x = t;
  t = y * Math.cos(a) - z * Math.sin(a); z = y * Math.sin(a) + z * Math.cos(a); y = t;
  return [x, y, z];
}

/** A point of `node`'s own space, through the frames above it (nearest first) into world space. */
export function throughChain(p: Vec3, chain: Frame[]): Vec3 {
  return chain.reduce((q, f) => rotateAbout(q, f.origin, f.rotation), p);
}

/** Every geometry point of `node` and all its descendants, in world space. */
export function worldPoints(node: GeoNode, chain: Frame[] = []): Vec3[] {
  if (node.kind === "group") {
    const inner: Frame[] = [{ origin: node.origin, rotation: node.rotation }, ...chain];
    return (node.children || []).flatMap((c) => worldPoints(c, inner));
  }
  let local: Vec3[] = [];
  if (node.kind === "cube" && node.from && node.to) {
    const g = node.inflate || 0;
    const lo = [0, 1, 2].map((i) => Math.min(node.from![i], node.to![i]) - g);
    const hi = [0, 1, 2].map((i) => Math.max(node.from![i], node.to![i]) + g);
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) local.push([x, y, z]);
  } else local = node.points || [];
  return local.map((p) => throughChain(rotateAbout(p, node.origin, node.rotation), chain));
}

export function boxOf(points: Vec3[]): Box | null {
  if (!points.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  return { min: roundVec(min), max: roundVec(max) };
}

export const roundVec = (v: number[]): Vec3 => [0, 1, 2].map((i) => Math.round(v[i] * 1e4) / 1e4 + 0) as Vec3;
export const boxCenter = (b: Box): Vec3 => roundVec([0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2));
export const shiftBox = (b: Box, d: Vec3): Box => ({ min: roundVec(b.min.map((v, i) => v + d[i])), max: roundVec(b.max.map((v, i) => v + d[i])) });

/**
 * The model-space offset to add to a node's coordinates so it moves by `worldDelta` in
 * world space: rotated parents turn a model-space move, so it is undone through them.
 */
export function toModelDelta(worldDelta: Vec3, chain: Frame[]): Vec3 {
  return roundVec([...chain].reverse().reduce((v, f) => unrotateVector(v, f.rotation), worldDelta));
}

// ---- place_relative ------------------------------------------------------------
// Sides in world axes. The model faces north (−Z), as Minecraft entity models do in
// Blockbench, so its front is −Z and its own left is −X (Blockbench's Bedrock import puts
// vanilla leftArm, pivot [5, 22, 0] in the file, at [-5, 22, 0]).
export const SIDES = ["on_top", "below", "left", "right", "front", "back", "inside"] as const;
export type Side = (typeof SIDES)[number];
export const ALIGNS = ["center", "min", "max", "keep"] as const;
export type Align = (typeof ALIGNS)[number];
/** One alignment for both other axes, or per axis ({ y: "min" } — unnamed axes are centred). */
export type AlignSpec = Align | Partial<Record<"x" | "y" | "z", Align>>;
export const isAlignSpec = (a: unknown): a is AlignSpec =>
  typeof a === "string" ? (ALIGNS as readonly string[]).includes(a)
    : !!a && typeof a === "object" && Object.entries(a).every(([k, v]) => ["x", "y", "z"].includes(k) && (ALIGNS as readonly string[]).includes(v as string));
const SIDE_AXIS: Record<Exclude<Side, "inside">, [number, 1 | -1]> = {
  on_top: [1, 1], below: [1, -1], left: [0, -1], right: [0, 1], front: [2, -1], back: [2, 1],
};

/**
 * World offset that puts `target` against `ref`'s `side` with `gap` between them (negative
 * = sunk in), and lines it up on the other two axes: centred, flush with ref's min or max
 * side, or kept where it is — the same way on both, or per axis. "inside" lines it up on
 * all three axes.
 */
export function placementDelta(target: Box, ref: Box, side: Side, o: { gap?: number; align?: AlignSpec; offset?: Vec3 } = {}): Vec3 {
  const gap = o.gap ?? 0;
  const alignOf = (i: number): Align => {
    const a = o.align ?? "center";
    return typeof a === "string" ? a : a[(["x", "y", "z"] as const)[i]] ?? "center";
  };
  const line = (i: number) => {
    const align = alignOf(i);
    return align === "keep" ? 0
      : align === "min" ? ref.min[i] - target.min[i]
        : align === "max" ? ref.max[i] - target.max[i]
          : (ref.min[i] + ref.max[i]) / 2 - (target.min[i] + target.max[i]) / 2;
  };
  const d: number[] = [0, 1, 2].map(line);
  if (side !== "inside") {
    const [axis, dir] = SIDE_AXIS[side];
    d[axis] = dir > 0 ? ref.max[axis] + gap - target.min[axis] : ref.min[axis] - gap - target.max[axis];
  }
  if (o.offset) for (let i = 0; i < 3; i++) d[i] += o.offset[i];
  return roundVec(d);
}

// ---- set_origin anchors ----------------------------------------------------------
export const ANCHORS = ["center", "top", "bottom", "left", "right", "front", "back"] as const;
export type Anchor = (typeof ANCHORS)[number];

/** The centre of a box, or the centre of one of its sides (left = −X, front = −Z). */
export function anchorPoint(b: Box, anchor: Anchor): Vec3 {
  const c = boxCenter(b);
  switch (anchor) {
    case "top": return [c[0], b.max[1], c[2]];
    case "bottom": return [c[0], b.min[1], c[2]];
    case "left": return [b.min[0], c[1], c[2]];
    case "right": return [b.max[0], c[1], c[2]];
    case "front": return [c[0], c[1], b.min[2]];
    case "back": return [c[0], c[1], b.max[2]];
    default: return c;
  }
}

// ---- mirrored copies ---------------------------------------------------------------
// The name pairs Blockbench's own Flip swaps (flipNameOnAxis): right/left across X,
// top/bottom across Y, back/front across Z; one-letter tokens only between separators.
const NAME_PAIRS: [string, string][][] = [
  [["right", "left"], ["Right", "Left"], ["RIGHT", "LEFT"], ["R", "L"], ["r", "l"]],
  [["top", "bottom"], ["Top", "Bottom"], ["TOP", "BOTTOM"]],
  [["back", "front"], ["rear", "front"], ["Back", "Front"], ["Rear", "Front"], ["BACK", "FRONT"], ["REAR", "FRONT"]],
];

/** The name a mirrored copy gets ("left_arm" → "right_arm"), or the same name if it has no side. */
export function mirroredName(name: string, axis: number): string {
  const swap = (from: string, to: string): string | null => {
    if (!name.includes(from)) return null;
    const pattern = from.length === 1 ? new RegExp(`(?<=^|[_. -])${from}(?=[_. -]|$)`) : from;
    const out = name.replace(pattern, to);
    return out === name ? null : out;
  };
  for (const [a, b] of NAME_PAIRS[axis] || []) {
    const out = swap(a, b) ?? swap(b, a);
    if (out) return out;
  }
  return name;
}

/** Mirror one coordinate across the plane `center` on an axis. */
export const mirrorCoord = (v: number, center: number) => Math.round((2 * center - v) * 1e4) / 1e4 + 0;
