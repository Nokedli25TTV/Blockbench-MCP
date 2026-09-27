// generate_animation: walk and idle loops, and attack / hurt / death one-shots, computed from the
// rig instead of keyed by hand. The model faces north (−Z) and its own left is −X. Values are what
// Blockbench shows (they add to the rest pose) and turn the right-handed way about the world axes
// (measured live): +X swings a hanging leg forward, leans an upright body back and lifts a head
// that points forward; +Y turns the model to its left; +Z tips it over to its left. A loop's last
// key repeats its first, so it has no seam. Pure, so it is tested without Blockbench.
import type { SceneTree, SceneNode, Vec3 } from "./types";
import { sceneBoxes } from "./spec.ts"; // with the extension: the tests run this file in Node directly
import { boxOf } from "./placement.ts";
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

/** What a fall and a side need beyond the rig: the root bones' pivots and the model's rest box. */
export interface RigFrame {
  /** Root bones with their pivots: a fall has to carry every one of them. */
  roots: { name: string; pivot: Vec3 }[];
  /** The whole model at rest. */
  box: Box | null;
  /** Each bone's box centre on X (its side: left is −X). */
  x: Record<string, number>;
  /** Cubes outside every bone — no animation moves them. */
  loose: string[];
}

export function rigFrame(tree: Pick<SceneTree, "roots">): RigFrame {
  const boxes = sceneBoxes(tree);
  const roots: RigFrame["roots"] = [], loose: string[] = [];
  for (const n of tree.roots || []) {
    if (n.type === "group") roots.push({ name: n.name, pivot: [n.origin[0], n.origin[1], n.origin[2]] });
    else loose.push(n.name);
  }
  const box = boxOf((tree.roots || []).flatMap((n) => (boxes[n.name] ? [boxes[n.name].min, boxes[n.name].max] : [])));
  const x = Object.fromEntries(Object.entries(boxes).map(([name, b]) => [name, centreX(b)]));
  return { roots, box, x, loose };
}

export type OneShot = { bones: Record<string, Key[]>; notes: string[] } | { error: string };

// A key at a fraction of the animation; missing channels are left out.
const keyAt = (length: number, f: number, rotation?: number[], position?: number[]): Key => ({
  time: r2(f * length),
  ...(rotation ? { rotation: rotation.map(r2) as Vec3 } : {}),
  ...(position ? { position: position.map(r2) as Vec3 } : {}),
});
// Keys for one bone from per-key values (every array as long as `fractions`).
const track = (length: number, fractions: number[], rot?: (i: number) => number[], pos?: (i: number) => number[]): Key[] =>
  fractions.map((f, i) => keyAt(length, f, rot?.(i), pos?.(i)));

/**
 * A one-shot attack. With an arm (default the right one): raised overhead, then a fast chop down to
 * the front, the body winding up and twisting into it, the other arm swinging back. With the head
 * (default when there are no arms): a bite — it rears up, then snaps down as the body lunges forward
 * (four legs reach and push). Starts and ends at rest.
 */
export function planAttack(rig: Rig, frame: RigFrame, o: { length?: number; limb?: string } = {}): OneShot {
  const length = o.length ?? 0.6;
  const limb = o.limb ?? rig.arms[1] ?? rig.head;
  if (!limb) return { error: "no arm or head to attack with — name them (arm_left / arm_right, head) or pass limb." };
  const bones: Record<string, Key[]> = {};
  const body = rig.body && rig.body !== limb ? rig.body : undefined;
  if (limb !== rig.head) {
    // s: +1 for a limb on the right (+X), −1 on the left; the body turns that shoulder back, then through.
    const F = [0, 0.2, 0.4, 0.5, 0.58, 0.75, 1];
    const s = limb === rig.arms[0] ? -1 : limb === rig.arms[1] ? 1 : Math.sign((frame.x[limb] ?? 0) - (frame.box ? centreX(frame.box) : 0)) || 1;
    const swing = [0, 85, 160, 95, 30, 40, 0];
    const lean = [0, 3, 6, -4, -10, -6, 0];
    const twist = [0, -8, -15, 5, 15, 10, 0].map((v) => v * s);
    bones[limb] = track(length, F, (i) => [swing[i], 0, 0]);
    const other = rig.arms.find((a) => a !== limb);
    if (other) bones[other] = track(length, F, (i) => [[0, -5, -10, -15, -25, -10, 0][i], 0, 0]);
    if (body) bones[body] = track(length, F, (i) => [lean[i], twist[i], 0]);
    if (rig.head && rig.head !== body && rig.head !== limb) bones[rig.head] = track(length, F, (i) => [-0.5 * lean[i], -0.6 * twist[i], 0]);
  } else {
    const F = [0, 0.3, 0.45, 0.65, 1];
    const size = frame.box ? Math.max(frame.box.max[1] - frame.box.min[1], frame.box.max[2] - frame.box.min[2]) : 16;
    const lunge = Math.min(4, Math.max(0.5, 0.08 * size));
    bones[limb] = track(length, F, (i) => [[0, 25, -20, -15, 0][i], 0, 0]);
    if (body) bones[body] = track(length, F, (i) => [[0, 4, -5, -4, 0][i], 0, 0], (i) => [0, 0, [0, 0.4, -1, -0.8, 0][i] * lunge]);
    if (rig.legs.length === 4) {
      const [fl, fr, bl, br] = rig.legs;
      for (const leg of [fl, fr]) bones[leg] = track(length, F, (i) => [[0, -8, 12, 8, 0][i], 0, 0]);
      for (const leg of [bl, br]) bones[leg] = track(length, F, (i) => [[0, 5, -8, -6, 0][i], 0, 0]);
    }
  }
  return { bones, notes: [] };
}

/** A one-shot flinch: the body and head jolt back, the arms fly out, then a small rebound to rest. */
export function planHurt(rig: Rig, o: { length?: number } = {}): OneShot {
  const length = o.length ?? 0.3;
  const F = [0, 0.3, 0.6, 1];
  const bones: Record<string, Key[]> = {};
  if (rig.body) bones[rig.body] = track(length, F, (i) => [[0, 8, -2, 0][i], 0, 0], (i) => [0, 0, [0, 0.5, 0, 0][i]]);
  if (rig.head && rig.head !== rig.body) bones[rig.head] = track(length, F, (i) => [[0, 12, -3, 0][i], 0, 0]);
  if (rig.arms.length === 2) {
    bones[rig.arms[0]] = track(length, F, (i) => [0, 0, [0, -12, 3, 0][i]]);
    bones[rig.arms[1]] = track(length, F, (i) => [0, 0, [0, 12, -3, 0][i]]);
  }
  if (!Object.keys(bones).length) return { error: "nothing to flinch — no body, head or arms found; pass body / head / arms." };
  return { bones, notes: [] };
}

/**
 * A one-shot death that holds its last frame: a stagger (the head drops, the model leans right),
 * then the whole model tips over to its left and ends lying on the ground — every root bone turns
 * about Z and shifts so the model moves as one piece about the bottom edge it leans over — while the
 * limbs on top lift and the head droops.
 *
 * Blockbench and GeckoLib blend keys in straight lines, while a turn about the edge moves each root's
 * pivot on an arc: between two keys a root sinks toward the edge by up to (1 − cos(Δ/2))·r (Δ the
 * turn between them, r its pivot's distance from the edge). So the fall is keyed every 10° and each
 * key lifts the model by the most it could sink next to it — a few hundredths of a unit.
 */
export function planDeath(rig: Rig, frame: RigFrame, o: { length?: number } = {}): OneShot {
  const length = o.length ?? 1;
  if (!frame.roots.length || !frame.box) return { error: "no bones to animate — a fall moves the root bones." };
  const box = frame.box;
  // A stagger right and back by 0.2, then gravity (the tip grows with the square of the time) until
  // it lands at 0.72, a small bounce, and it lies still.
  const tipAt = (f: number) => f <= 0.1 ? -40 * f : f <= 0.2 ? -4 + 40 * (f - 0.1)
    : f <= 0.72 ? 90 * ((f - 0.2) / 0.52) ** 2 : f <= 0.8 ? 90 - 75 * (f - 0.72) : f <= 0.9 ? 84 + 60 * (f - 0.8) : 90;
  const F = [0, 0.1, 0.2, ...[10, 20, 30, 40, 50, 60, 70, 80].map((a) => 0.2 + 0.52 * Math.sqrt(a / 90)), 0.72, 0.8, 0.9, 1];
  const tip = F.map(tipAt);
  // The hinge is the bottom edge it leans over: the right one while it staggers right, else the left.
  const edgeOf = (a: number): [number, number] => [a < 0 ? box.max[0] : box.min[0], box.min[1]];
  const reach = (a: number) => Math.max(...frame.roots.map((r) => Math.hypot(r.pivot[0] - edgeOf(a)[0], r.pivot[1] - edgeOf(a)[1])));
  const sag = F.slice(1).map((_, k) => (1 - Math.cos((Math.abs(tip[k + 1] - tip[k]) * Math.PI) / 360)) * reach(tip[k] + tip[k + 1]));
  const lift = F.map((_, i) => (i === 0 || i === F.length - 1 ? 0 : Math.max(sag[i - 1], sag[i])));
  const ramp = (f: number) => Math.min(1, Math.max(0, (f - 0.35) / (0.72 - 0.35))); // the limbs follow the fall
  const headDrop = (f: number) => {
    const P = [[0, 0], [0.1, -8], [0.2, -12], [0.35, -20], [0.55, -20], [0.72, -15], [0.8, -18], [0.9, -15], [1, -15]];
    const j = P.findIndex(([t]) => t >= f);
    if (j <= 0) return P[Math.max(j, 0)][1];
    const [t0, v0] = P[j - 1], [t1, v1] = P[j];
    return v0 + ((v1 - v0) * (f - t0)) / (t1 - t0);
  };
  // Each limb's own turn on top of the fall, [x, z] at the end: those on top lift; the side it lands
  // on keeps still, or it would turn into the ground on the way down.
  const own: Record<string, [number, number]> = {};
  if (rig.arms.length === 2) { own[rig.arms[0]] = [0, 5]; own[rig.arms[1]] = [0, 20]; }
  if (rig.legs.length === 2) own[rig.legs[1]] = [0, 8];
  if (rig.legs.length === 4) { own[rig.legs[1]] = [10, 8]; own[rig.legs[3]] = [-10, 8]; }
  const head = rig.head && rig.head !== rig.body ? rig.head : undefined;
  const bones: Record<string, Key[]> = {};
  const roots = new Map(frame.roots.map((r) => [r.name, r.pivot]));
  for (const name of new Set([...roots.keys(), ...Object.keys(own), ...(head ? [head] : [])])) {
    const pivot = roots.get(name);
    const [ox, oz] = own[name] ?? [0, 0];
    bones[name] = track(length, F,
      (i) => [name === head ? headDrop(F[i]) : ox * ramp(F[i]), 0, (pivot ? tip[i] : 0) + oz * ramp(F[i])],
      pivot ? (i) => {
        // Shift the root so its turn about its own pivot equals the turn about the edge: (R − I)(pivot − edge).
        const [ex, ey] = edgeOf(tip[i]);
        const a = (tip[i] * Math.PI) / 180, dx = pivot[0] - ex, dy = pivot[1] - ey;
        return [dx * Math.cos(a) - dy * Math.sin(a) - dx, dx * Math.sin(a) + dy * Math.cos(a) - dy + lift[i], 0];
      } : undefined);
  }
  const notes = frame.loose.length ? [`${frame.loose.join(", ")} ${frame.loose.length > 1 ? "are cubes" : "is a cube"} outside every bone — no animation moves ${frame.loose.length > 1 ? "them" : "it"}, so ${frame.loose.length > 1 ? "they stay" : "it stays"} standing; put ${frame.loose.length > 1 ? "them" : "it"} in a bone.`] : [];
  return { bones, notes };
}
