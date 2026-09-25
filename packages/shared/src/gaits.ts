// generate_animation: walk and idle loops computed from the rig instead of keyed by hand.
// The model faces north (−Z), so a leg hanging from its hip swings forward with +X rotation;
// left is −X. Values are what Blockbench shows (they add to the rest pose); the last key
// repeats the first, so the loop has no seam. Pure, so it is tested without Blockbench.
import type { SceneTree, SceneNode } from "./types";
import { sceneBoxes } from "./spec.ts"; // with the extension: the tests run this file in Node directly
import type { Box } from "./placement.ts";

export type Key = { time: number; rotation?: [number, number, number]; position?: [number, number, number] };
export interface Rig { legs: string[]; arms: string[]; body?: string; head?: string }
export interface GaitOptions { length?: number; stride?: number; arm_swing?: number; bob?: number; sway?: number; steps?: number }

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const centreX = (b: Box) => (b.min[0] + b.max[0]) / 2;
const centreZ = (b: Box) => (b.min[2] + b.max[2]) / 2;

/**
 * Find the rig by bone names: legs and arms (left = −X), body (body / torso / chest, else the
 * root bone) and head. Four legs are ordered front-left, front-right, back-left, back-right.
 */
export function findRig(tree: Pick<SceneTree, "roots">, given: Partial<Rig> = {}): Rig & { warnings: string[] } {
  const groups: { name: string; node: SceneNode }[] = [];
  const walk = (nodes: SceneNode[]) => nodes.forEach((n) => { if (n.type === "group") { groups.push({ name: n.name, node: n }); walk(n.children || []); } });
  walk(tree.roots || []);
  const boxes = sceneBoxes(tree);
  const x = (n: string) => (boxes[n] ? centreX(boxes[n]) : 0);
  const z = (n: string) => (boxes[n] ? centreZ(boxes[n]) : 0);
  const named = (re: RegExp) => groups.map((g) => g.name).filter((n) => re.test(n) && boxes[n]);
  const warnings: string[] = [];

  let legs = given.legs ?? named(/leg/i).filter((n) => !/lower|foot|shin|calf|knee/i.test(n));
  if (!given.legs) {
    if (legs.length === 2) legs = [...legs].sort((a, b) => x(a) - x(b));
    else if (legs.length === 4) {
      const [f1, f2, b1, b2] = [...legs].sort((a, b) => z(a) - z(b)); // front (−Z) first
      legs = [...[f1, f2].sort((a, b) => x(a) - x(b)), ...[b1, b2].sort((a, b) => x(a) - x(b))];
    } else legs = [];
  }
  let arms = given.arms ?? named(/arm/i).filter((n) => !/fore|lower|hand/i.test(n));
  if (!given.arms) arms = arms.length === 2 ? [...arms].sort((a, b) => x(a) - x(b)) : [];
  const body = given.body ?? named(/body|torso|chest/i)[0] ?? (tree.roots || []).find((n) => n.type === "group")?.name;
  const head = given.head ?? named(/head/i)[0];

  // A leg or arm swings about its pivot: it belongs at the hip / shoulder, the top of the part.
  for (const n of [...legs, ...arms]) {
    const g = groups.find((x) => x.name === n)?.node as any;
    const b = boxes[n];
    if (g && b && Math.abs(g.origin[1] - b.max[1]) > 1) warnings.push(`"${n}" pivots at y ${r2(g.origin[1])} but its top is at y ${r2(b.max[1])} — it will swing from the wrong point; set_origin anchor "top" first.`);
  }
  if (given.legs && ![2, 4].includes(given.legs.length)) warnings.push("legs takes 2 names (left, right) or 4 (front-left, front-right, back-left, back-right).");
  return { legs, arms, body, head, warnings };
}

const sampleTimes = (length: number, steps: number) => Array.from({ length: steps + 1 }, (_, k) => r2((k * length) / steps));

/** A walk cycle: legs in opposite phase (four legs trot: diagonal pairs together), arms against the legs, body bob and sway. */
export function planWalk(rig: Rig, o: GaitOptions = {}): Record<string, Key[]> {
  const length = o.length ?? 1, stride = o.stride ?? 30, armSwing = o.arm_swing ?? 25, bob = o.bob ?? 0.5, sway = o.sway ?? 2, steps = o.steps ?? 8;
  const times = sampleTimes(length, steps);
  const phase = (t: number) => (2 * Math.PI * t) / length;
  const bones: Record<string, Key[]> = {};
  const swing = (name: string | undefined, amount: number) => {
    if (!name) return;
    bones[name] = times.map((t) => ({ time: t, rotation: [r2(amount * Math.cos(phase(t))), 0, 0] }));
  };
  if (rig.legs.length === 4) {
    const [fl, fr, bl, br] = rig.legs;
    swing(fl, stride); swing(br, stride); swing(fr, -stride); swing(bl, -stride);
  } else if (rig.legs.length === 2) {
    swing(rig.legs[0], stride); swing(rig.legs[1], -stride);
  }
  if (rig.arms.length === 2) { swing(rig.arms[0], -armSwing); swing(rig.arms[1], armSwing); }
  if (rig.body) {
    // Highest when the legs pass each other, lowest at the widest step; leaning over the stance leg.
    bones[rig.body] = times.map((t) => ({
      time: t,
      position: [0, r2((bob * (1 - Math.cos(2 * phase(t)))) / 2), 0],
      rotation: [0, 0, r2(sway * Math.sin(phase(t)))],
    }));
  }
  if (rig.head && rig.head !== rig.body) {
    bones[rig.head] = times.map((t) => ({ time: t, rotation: [0, 0, r2(-sway * 0.5 * Math.sin(phase(t)))] })); // keeps the head level
  }
  return bones;
}

/** An idle loop: slow breathing on the body, a slight arm drift and a small head nod. */
export function planIdle(rig: Rig, o: GaitOptions = {}): Record<string, Key[]> {
  const length = o.length ?? 3, breath = o.bob ?? 0.3, sway = o.sway ?? 2, steps = o.steps ?? 6;
  const times = sampleTimes(length, steps);
  const phase = (t: number) => (2 * Math.PI * t) / length;
  const bones: Record<string, Key[]> = {};
  if (rig.body) bones[rig.body] = times.map((t) => ({ time: t, position: [0, r2((breath * (1 - Math.cos(phase(t)))) / 2), 0] }));
  if (rig.arms.length === 2) {
    bones[rig.arms[0]] = times.map((t) => ({ time: t, rotation: [0, 0, r2(-sway * (1 - Math.cos(phase(t))) / 2)] }));
    bones[rig.arms[1]] = times.map((t) => ({ time: t, rotation: [0, 0, r2(sway * (1 - Math.cos(phase(t))) / 2)] }));
  }
  if (rig.head && rig.head !== rig.body) bones[rig.head] = times.map((t) => ({ time: t, rotation: [r2(sway * 0.75 * Math.sin(phase(t))), 0, 0] }));
  return bones;
}
