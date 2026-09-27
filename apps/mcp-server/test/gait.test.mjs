// generate_animation: the rig finder and the walk / idle planners (packages/shared/src/gaits.ts,
// straight from the TypeScript source), then the tool through the server and the mock.
import { findRig, planWalk, planIdle, rigFrame, planAttack, planHurt, planDeath } from "../../../packages/shared/src/gaits.ts";
import { planSpec } from "../../../packages/shared/src/spec.ts";
import { templateParts } from "../../../packages/shared/src/templates.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const J = JSON.stringify;

// A scene tree from a create_from_spec plan (bones with one cube each).
const treeOf = (plan) => {
  const byName = new Map();
  const roots = [];
  for (const g of plan.groups) {
    const node = { type: "group", name: g.name, origin: g.origin, rotation: g.rotation || [0, 0, 0], children: [] };
    byName.set(g.name, node);
    (g.parent ? byName.get(g.parent).children : roots).push(node);
  }
  for (const c of plan.cubes) byName.get(c.parent).children.push({ type: "cube", name: c.name, from: c.from, to: c.to, origin: c.from, rotation: [0, 0, 0] });
  return { roots };
};
const HUMANOID = [
  { name: "body", size: [8, 12, 4], from: [-4, 12, -2], pivot: "bottom" },
  { name: "head", size: [8, 8, 8], parent: "body", attach: { to: "body", side: "on_top" }, pivot: "bottom" },
  { name: "arm_left", size: [4, 12, 4], parent: "body", attach: { to: "body", side: "left", align: "max" }, pivot: "top", mirror: "x" },
  { name: "leg_left", size: [4, 12, 4], attach: { to: "body", side: "below", align: "min" }, pivot: "top", mirror: "x" },
];

console.log("--- rig ---");
const rig = findRig(treeOf(planSpec(HUMANOID)));
check("legs found, left (−X) first", J(rig.legs) === J(["leg_left", "leg_right"]), J(rig.legs));
check("arms found, left first; body and head", J(rig.arms) === J(["arm_left", "arm_right"]) && rig.body === "body" && rig.head === "head", J(rig));
check("hip and shoulder pivots at the top: no warnings", rig.warnings.length === 0, J(rig.warnings));
const badPivot = findRig(treeOf(planSpec([{ name: "leg_l", size: [4, 12, 4], from: [-4, 0, -2] }, { name: "leg_r", size: [4, 12, 4], from: [0, 0, -2] }])));
check("a leg pivoting at its centre is flagged", badPivot.warnings.length === 2 && /set_origin anchor "top"/.test(badPivot.warnings[0]), badPivot.warnings[0]);
const quad = findRig(treeOf(planSpec([
  { name: "body", size: [8, 6, 14], from: [-4, 8, -7] },
  { name: "leg_front_left", size: [2, 8, 2], from: [-4, 0, -7], pivot: "top" }, { name: "leg_front_right", size: [2, 8, 2], from: [2, 0, -7], pivot: "top" },
  { name: "leg_back_left", size: [2, 8, 2], from: [-4, 0, 5], pivot: "top" }, { name: "leg_back_right", size: [2, 8, 2], from: [2, 0, 5], pivot: "top" },
])));
check("four legs ordered front-left, front-right, back-left, back-right", J(quad.legs) === J(["leg_front_left", "leg_front_right", "leg_back_left", "leg_back_right"]), J(quad.legs));

console.log("\n--- walk / idle ---");
const walk = planWalk(rig);
const rot = (bone, i) => walk[bone][i].rotation;
check("9 keys per bone over 1 s, the last repeats the first (no seam)", Object.values(walk).every((k) => k.length === 9 && k[8].time === 1 && J(k[0].rotation ?? null) === J(k[8].rotation ?? null) && J(k[0].position ?? null) === J(k[8].position ?? null)));
check("legs in opposite phase: left forward (+X) while right back", near(rot("leg_left", 0), [30, 0, 0]) && near(rot("leg_right", 0), [-30, 0, 0]) && near(rot("leg_left", 4), [-30, 0, 0]));
check("arms swing against the legs on their side", near(rot("arm_left", 0), [-25, 0, 0]) && near(rot("arm_right", 0), [25, 0, 0]));
check("body lowest at the widest step, highest as the legs pass", near(walk.body[0].position, [0, 0, 0]) && near(walk.body[2].position, [0, 0.5, 0]) && near(walk.body[4].position, [0, 0, 0]));
check("body leans over the stance leg (left, −X, at a quarter cycle)", near(walk.body[2].rotation, [0, 0, 2]));
check("the head counters the lean", near(walk.head[2].rotation, [0, 0, -1]));
const trot = planWalk(quad);
check("four legs trot: diagonal pairs together", near(trot.leg_front_left[0].rotation, trot.leg_back_right[0].rotation) && near(trot.leg_front_right[0].rotation, trot.leg_back_left[0].rotation) && trot.leg_front_left[0].rotation[0] === -trot.leg_front_right[0].rotation[0]);
const idle = planIdle(rig);
check("idle: 3 s, seamless, breathing peaks half way", idle.body.length === 7 && near(idle.body[0].position, idle.body[6].position) && near(idle.body[3].position, [0, 0.3, 0]));
check("idle: arms drift outward (left toward −X)", idle.arm_left[3].rotation[2] < 0 && idle.arm_right[3].rotation[2] > 0);

console.log("\n--- attack / hurt / death ---");
// Pose a tree at key i: key rotations add to each bone's, a key position shifts the bone and all inside it.
const posed = (tree, bones, i) => {
  const shift = (n, d) => {
    n.origin = n.origin.map((v, k) => v + d[k]);
    if (n.type === "cube") { n.from = n.from.map((v, k) => v + d[k]); n.to = n.to.map((v, k) => v + d[k]); }
    else n.children.forEach((c) => shift(c, d));
  };
  const walk = (n) => {
    if (n.type !== "group") return;
    const key = bones[n.name]?.[i];
    if (key?.rotation) n.rotation = n.rotation.map((v, k) => v + key.rotation[k]);
    if (key?.position) shift(n, key.position);
    n.children.forEach(walk);
  };
  const copy = structuredClone(tree);
  copy.roots.forEach(walk);
  return copy;
};
// The keys blended at time t the way Blockbench plays them: straight lines between neighbours.
const sample = (bones, t) => Object.fromEntries(Object.entries(bones).map(([n, keys]) => {
  const j = keys.findIndex((k) => k.time >= t);
  if (j === -1) return [n, [keys.at(-1)]];
  if (j === 0) return [n, [keys[0]]];
  const a = keys[j - 1], b = keys[j], u = (t - a.time) / (b.time - a.time);
  const mix = (p, q) => (p || q ? [0, 1, 2].map((k) => (p?.[k] ?? 0) + ((q?.[k] ?? 0) - (p?.[k] ?? 0)) * u) : undefined);
  return [n, [{ time: t, rotation: mix(a.rotation, b.rotation), position: mix(a.position, b.position) }]];
}));
const lowest = (tree, bones, length) => Math.min(...Array.from({ length: 101 }, (_, s) => rigFrame(posed(tree, sample(bones, (s / 100) * length), 0)).box.min[1]));
const steps = (bones) => Math.max(...Object.values(bones).flatMap((keys) => keys.slice(1).map((k, i) => Math.max(...[0, 1, 2].map((a) => Math.abs((k.rotation?.[a] ?? 0) - (keys[i].rotation?.[a] ?? 0)))))));
const atRest = (bones, i) => Object.values(bones).every((keys) => [...(keys[i].rotation ?? []), ...(keys[i].position ?? [])].every((v) => v === 0));
const humanTree = treeOf(planSpec(HUMANOID));
const humanFrame = rigFrame(humanTree);
check("rigFrame: root bones with their pivots, the rest box", J(humanFrame.roots.map((r) => r.name)) === J(["body", "leg_left", "leg_right"]) && near(humanFrame.roots[0].pivot, [0, 12, 0]) && near(humanFrame.box.min, [-8, 0, -4]) && near(humanFrame.box.max, [8, 32, 4]), J(humanFrame.box));

const chop = planAttack(rig, humanFrame).bones;
const x = (bone, i) => chop[bone][i].rotation[0], y = (bone, i) => chop[bone][i].rotation[1];
check("attack: the right arm by default, 7 keys over 0.6 s, from rest back to rest", J(Object.keys(chop).sort()) === J(["arm_left", "arm_right", "body", "head"]) && J(chop.arm_right.map((k) => k.time)) === J([0, 0.12, 0.24, 0.3, 0.35, 0.45, 0.6]) && atRest(chop, 0) && atRest(chop, 6), J(chop.arm_right.map((k) => k.time)));
check("attack: raised overhead (160°), then chopped down to the front (30°)", x("arm_right", 2) === 160 && x("arm_right", 4) === 30, J(chop.arm_right.map((k) => k.rotation[0])));
check("attack: the right shoulder winds back (−Y), then comes through (+Y); the body leans in", y("body", 2) === -15 && y("body", 4) === 15 && x("body", 2) > 0 && x("body", 4) < 0);
const leftChop = planAttack(rig, humanFrame, { limb: "arm_left" }).bones;
check("attack with the left arm: the twist turns the other way", leftChop.body[2].rotation[1] === 15 && leftChop.body[4].rotation[1] === -15 && leftChop.arm_left[2].rotation[0] === 160);
check("attack: no rotation step over 90° (check_animation stays quiet)", steps(chop) <= 90 && steps(leftChop) <= 90, `${steps(chop)}°`);
const quadTree = treeOf(planSpec(templateParts("quadruped")));
const quadRig = findRig(quadTree);
const bite = planAttack(quadRig, rigFrame(quadTree)).bones;
check("attack without arms: the head bites — rears up, snaps down", bite.head[1].rotation[0] === 25 && bite.head[2].rotation[0] === -20, J(bite.head.map((k) => k.rotation[0])));
check("…the body lunges forward (−Z) as it snaps; front legs reach, back legs push", bite.body[2].position[2] < 0 && bite.body[1].position[2] > 0 && bite.leg_front_left[2].rotation[0] > 0 && bite.leg_back_right[2].rotation[0] < 0, J(bite.body.map((k) => k.position)));
check("attack with nothing to strike with is refused", "error" in planAttack({ legs: [], arms: [] }, rigFrame({ roots: [] })));

const flinch = planHurt(rig).bones;
check("hurt: 0.3 s, the body leans back (+X) and the head snaps back, then rest", flinch.body[1].rotation[0] === 8 && flinch.head[1].rotation[0] === 12 && flinch.body.at(-1).time === 0.3 && atRest(flinch, 3));
check("hurt: the arms fly out (left −Z, right +Z)", flinch.arm_left[1].rotation[2] < 0 && flinch.arm_right[1].rotation[2] > 0);

const death = planDeath(rig, humanFrame);
const fall = death.bones;
const last = fall.body.length - 1;
const settle = Math.max(...Object.values(fall).map((k) => (k[last].position ? Math.abs(k[last].position[1] - k[last - 1].position[1]) : 0)));
check("death: every root bone falls, the limbs react; from rest to a held pose (the last keys turn alike, the lift settles by a hair)", ["body", "leg_left", "leg_right", "head", "arm_left", "arm_right"].every((n) => fall[n]) && atRest(fall, 0) && Object.values(fall).every((k) => J(k[last].rotation) === J(k[last - 1].rotation)) && settle < 0.05, `settles ${settle.toFixed(4)}`);
check("death: keyed every 10° while it falls (straight-line blending stays close to the arc)", fall.body.length === 15 && fall.body.slice(3, 11).every((k, i) => Math.abs(k.rotation[2] - (i + 1) * 10) < 1e-9), J(fall.body.map((k) => k.rotation[2])));
check("death: a stagger to the right first, then 90° over to its left (+Z)", fall.body[1].rotation[2] === -4 && fall.body[last].rotation[2] === 90, J(fall.body.map((k) => k.rotation[2])));
const lying = rigFrame(posed(humanTree, fall, last)).box;
check("death: the model ends lying on the ground, left of where it stood (its left edge is the hinge)", lying.min[1] > -0.01 && lying.max[1] < 22 && lying.max[0] < -7.5 && lying.min[0] < -38, J(lying));
const fallLow = lowest(humanTree, fall, 1);
check("death: nothing goes below the ground at any moment — the stagger right leans over the right edge", fallLow > -0.01, `lowest y ${fallLow.toFixed(3)}`);
check("attack / hurt stay above the ground too (the legs are not moved)", lowest(humanTree, chop, 0.6) > -0.01 && lowest(humanTree, planHurt(rig).bones, 0.3) > -0.01);
check("death: no rotation step over 90°", steps(fall) <= 90, `${steps(fall).toFixed(1)}°`);
const quadDeath = planDeath(quadRig, rigFrame(quadTree)).bones;
const quadLying = rigFrame(posed(quadTree, quadDeath, quadDeath.body.length - 1)).box;
check("death on four legs: lies on the ground too; the legs on top splay front / back, the ones below keep still", quadLying.min[1] > -0.01 && quadDeath.leg_front_right.at(-1).rotation[0] > 0 && quadDeath.leg_back_right.at(-1).rotation[0] < 0 && quadDeath.leg_front_left.at(-1).rotation[0] === 0, J(quadLying));
const quadLow = lowest(quadTree, quadDeath, 1);
check("death on four legs: never below the ground", quadLow > -0.01, `lowest y ${quadLow.toFixed(3)}`);
// A box leg swung about the middle of its top dips a bottom corner by up to √(length² + (depth/2)²) − length
// (8 long, 3 deep: 0.139) — every swing does it, the walk's too; the bite dips no further.
const biteLow = lowest(quadTree, bite, 0.6);
check("the bite dips a foot corner no deeper than any leg swing does (≤ 0.14)", biteLow > -0.145, `lowest y ${biteLow.toFixed(3)}`);
const loose = planDeath(rig, rigFrame({ roots: [...humanTree.roots, { type: "cube", name: "stray", from: [10, 0, 0], to: [11, 1, 1], origin: [10, 0, 0], rotation: [0, 0, 0] }] }));
check("death: a cube outside every bone is named — it would stay standing", loose.notes.length === 1 && /stray is a cube outside every bone/.test(loose.notes[0]), loose.notes[0]);

console.log("\n--- through the server (mock Blockbench) ---");
const h = await startHarness();
try {
  h.mock.setFormat({ id: "geckolib_model", bone_rig: true, rotate_cubes: true });
  const none = await h.call("generate_animation", { kind: "walk" });
  check("no legs: a clear error", none.isError && /no legs found/.test(none.text), none.text);
  await h.call("create_from_spec", { parts: HUMANOID });
  const dry = await h.call("generate_animation", { kind: "walk", dry_run: true });
  check("dry_run: the plan, nothing created", !dry.isError && /Plan \(nothing created\): walk "walk", 1s loop, 6 bone\(s\), 54 keyframe\(s\) — legs leg_left \/ leg_right, arms arm_left \/ arm_right, body body, head head/.test(dry.text), dry.text);
  const made = await h.call("generate_animation", { kind: "walk" });
  check("walk created and checked", !made.isError && /Created animation\.walk \(walk, 1s loop, seamless\)/.test(made.text) && /check_animation:/.test(made.text), made.text.replace(/\n/g, " ⏎ "));
  const idleMade = await h.call("generate_animation", { kind: "idle", name: "breathe", length: 4 });
  check("idle created under its own name", !idleMade.isError && /Created animation\.breathe \(idle, 4s loop/.test(idleMade.text), idleMade.text.split("\n")[0]);
  const again = await h.call("generate_animation", { kind: "walk" });
  check("the same name twice is refused", again.isError && /already exists/.test(again.text), again.text);
  const attackPlan = await h.call("generate_animation", { kind: "attack", dry_run: true });
  check("attack dry run: plays once, 4 bones × 7 keys", !attackPlan.isError && /Plan \(nothing created\): attack "attack", 0\.6s, plays once, 4 bone\(s\), 28 keyframe\(s\) — arms arm_left \/ arm_right, body body, head head\./.test(attackPlan.text), attackPlan.text);
  const attack = await h.call("generate_animation", { kind: "attack" });
  check("attack created: plays once, with the GeckoLib call", !attack.isError && /Created animation\.attack \(attack, 0\.6s, plays once\)/.test(attack.text) && /RawAnimation\.begin\(\)\.thenPlay\("animation\.attack"\)\./.test(attack.text), attack.text.replace(/\n/g, " ⏎ "));
  const hurt = await h.call("generate_animation", { kind: "hurt" });
  check("hurt created: 0.3 s, plays once", !hurt.isError && /Created animation\.hurt \(hurt, 0\.3s, plays once\)/.test(hurt.text), hurt.text.split("\n")[0]);
  const death = await h.call("generate_animation", { kind: "death" });
  check("death created: holds its last frame; thenPlayAndHold and the renderer's death tilt named", !death.isError && /Created animation\.death \(death, 1s, holds its last frame\)/.test(death.text) && /thenPlayAndHold\("animation\.death"\)/.test(death.text) && /getDeathMaxRotation/.test(death.text), death.text.replace(/\n/g, " ⏎ "));
  const noLimb = await h.call("generate_animation", { kind: "attack", limb: "tail" });
  check("an unknown limb is refused", noLimb.isError && /limb "tail" is not a bone/.test(noLimb.text), noLimb.text);
  const hold = await h.call("create_animation", { name: "pose", loop: "hold", bones: { head: [{ time: 0, rotation: [10, 0, 0] }] } });
  check("create_animation takes a loop mode: hold", !hold.isError && /holds its last frame/.test(hold.text), hold.text);
  const once = await h.call("create_animation", { name: "nod", loop: false, bones: { head: [{ time: 0, rotation: [10, 0, 0] }] } });
  check("…and still true / false (false: plays once)", !once.isError && /plays once/.test(once.text), once.text);
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 GAIT CHECKS PASSED" : "💥 " + failures + " GAIT CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
