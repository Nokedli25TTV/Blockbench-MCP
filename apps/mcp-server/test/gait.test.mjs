// generate_animation: the rig finder and the walk / idle planners (packages/shared/src/gaits.ts,
// straight from the TypeScript source), then the tool through the server and the mock.
import { findRig, planWalk, planIdle } from "../../../packages/shared/src/gaits.ts";
import { planSpec } from "../../../packages/shared/src/spec.ts";
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
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 GAIT CHECKS PASSED" : "💥 " + failures + " GAIT CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
