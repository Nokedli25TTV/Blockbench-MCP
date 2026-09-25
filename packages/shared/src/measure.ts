// measure: where parts are relative to each other — the gap or the overlap between two world
// boxes, the distance, and on which side one is of the other, in place_relative's words (the
// model faces north: front −Z, its own left −X). Pure, so it is tested without Blockbench.
import type { Vec3 } from "./types";
import { boxCenter, roundVec } from "./placement.ts"; // with the extension: the tests run this file in Node directly
import type { Box, Side } from "./placement.ts";

export interface BoxRelation {
  /** Per axis: the space between the boxes (> 0), or how far they reach into each other (< 0). */
  gap: Vec3;
  state: "apart" | "touching" | "overlapping";
  /** The shortest distance between them; 0 unless apart. */
  distance: number;
  /** The axis that separates them most — or, when they overlap, the one to part them along. */
  axis: "x" | "y" | "z";
  /** Where `a` is relative to `b` along that axis; "inside" when `a` is within `b`. */
  side: Side | null;
  /** `b` lies within `a`. */
  contains: boolean;
  /** The box both share, and its volume, when they overlap. */
  shared?: { box: Box; volume: number };
}

const EPS = 1e-4;
const round = (n: number) => Math.round(n * 1e4) / 1e4 + 0;
const AXES = ["x", "y", "z"] as const;
const SIDE_ON: Record<number, [Side, Side]> = { 0: ["left", "right"], 1: ["below", "on_top"], 2: ["front", "back"] };

export const boxSize = (b: Box): Vec3 => roundVec([0, 1, 2].map((i) => b.max[i] - b.min[i]));

export function boxRelation(a: Box, b: Box): BoxRelation {
  const gap = roundVec([0, 1, 2].map((i) => Math.max(a.min[i] - b.max[i], b.min[i] - a.max[i])));
  const within = (p: Box, q: Box) => [0, 1, 2].every((i) => p.min[i] >= q.min[i] - EPS && p.max[i] <= q.max[i] + EPS);
  const i = [0, 1, 2].reduce((best, k) => (gap[k] > gap[best] + EPS ? k : best), 0);
  const axis = AXES[i];
  const ca = boxCenter(a), cb = boxCenter(b);
  const sideAlong = SIDE_ON[i][ca[i] >= cb[i] ? 1 : 0];
  if (gap[i] > EPS) {
    return { gap, state: "apart", distance: round(Math.hypot(...gap.map((g) => Math.max(g, 0)))), axis, side: sideAlong, contains: false };
  }
  if (gap[i] > -EPS) return { gap, state: "touching", distance: 0, axis, side: sideAlong, contains: false };
  const min = roundVec([0, 1, 2].map((i) => Math.max(a.min[i], b.min[i])));
  const max = roundVec([0, 1, 2].map((i) => Math.min(a.max[i], b.max[i])));
  const volume = round((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]));
  const inside = within(a, b), contains = !inside && within(b, a);
  return { gap, state: "overlapping", distance: 0, axis, side: inside ? "inside" : contains ? null : sideAlong, contains, shared: { box: { min, max }, volume } };
}

const vec = (v: number[]) => `[${v.map(round).join(", ")}]`;

/** "a → b: left, touching on x" — where `a` is relative to `b`, as one line. */
export function relationText(aName: string, bName: string, r: BoxRelation): string {
  const head = `${aName} → ${bName}: `;
  if (r.state === "apart") {
    const spaced = [0, 1, 2].filter((i) => r.gap[i] > EPS).map((i) => `${round(r.gap[i])} on ${AXES[i]}`);
    return `${head}${r.side}, apart — ${spaced.length > 1 ? `distance ${r.distance} (${spaced.join(", ")})` : spaced[0]}`;
  }
  if (r.state === "touching") return `${head}${r.side}, touching on ${r.axis}`;
  const shared = r.shared ? ` (shared ${vec(r.shared.box.min)}→${vec(r.shared.box.max)}, volume ${r.shared.volume})` : "";
  if (r.side === "inside") return `${head}inside — within it on every axis${shared}`;
  if (r.contains) return `${head}contains it — ${bName} is within ${aName} on every axis${shared}`;
  return `${head}${r.side}, OVERLAPPING — ${round(-r.gap[AXES.indexOf(r.axis)])} deep on ${r.axis}${shared}`;
}
