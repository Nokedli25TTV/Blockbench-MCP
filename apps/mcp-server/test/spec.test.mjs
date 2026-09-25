// create_from_spec: the planner (packages/shared/src/spec.ts, straight from the TypeScript
// source) and the tool through the server and the mock — a whole humanoid in one call.
import { planSpec, sceneBoxes } from "../../../packages/shared/src/spec.ts";
import { templateParts } from "../../../packages/shared/src/templates.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const J = JSON.stringify;

// The model faces north: front = −Z, its own left = −X.
const HUMANOID = [
  { name: "body", size: [8, 12, 4], from: [-4, 12, -2], pivot: "bottom" },
  { name: "head", size: [8, 8, 8], parent: "body", attach: { to: "body", side: "on_top" }, pivot: "bottom" },
  { name: "arm_left", size: [4, 12, 4], parent: "body", attach: { to: "body", side: "left", align: "max" }, pivot: "top", rotation: [0, 5, -10], mirror: "x" },
  { name: "hand_left", size: [4, 3, 4], parent: "arm_left", attach: { to: "arm_left", side: "below" }, mirror: "x" },
  { name: "leg_left", size: [4, 12, 4], attach: { to: "body", side: "below", align: "min" }, pivot: "top", mirror: "x" },
];

console.log("--- planner ---");
const plan = planSpec(HUMANOID);
check("the humanoid plans", !plan.error, plan.error);
const g = (n) => plan.groups.find((x) => x.name === n), c = (n) => plan.cubes.find((x) => x.name === n);
check("5 parts + 3 twins = 8 bones, 8 cubes", plan.groups.length === 8 && plan.cubes.length === 8, plan.groups.map((x) => x.name).join(", "));
check("head rests on the body, centred; pivot at its bottom", near(c("head_cube").from, [-4, 24, -4]) && near(c("head_cube").to, [4, 32, 4]) && near(g("head").origin, [0, 24, 0]));
check("arm_left on the model's left (−X), flush with the body's top, shoulder pivot", near(c("arm_left_cube").from, [-8, 12, -2]) && near(c("arm_left_cube").to, [-4, 24, 2]) && near(g("arm_left").origin, [-6, 24, 0]), J(c("arm_left_cube")));
check("arm_right is the mirror twin (+X), rotation mirrored", near(c("arm_right_cube").from, [4, 12, -2]) && near(g("arm_right").origin, [6, 24, 0]) && near(g("arm_right").rotation, [0, -5, 10]) && g("arm_right").parent === "body", J(g("arm_right")));
check("hand_left hangs below the arm", near(c("hand_left_cube").from, [-8, 9, -2]) && g("hand_left").parent === "arm_left");
check("hand_right follows its twin parent arm_right", g("hand_right").parent === "arm_right" && near(c("hand_right_cube").from, [4, 9, -2]), J(g("hand_right")));
check("legs: left under the body's left half, hip pivot; right mirrored", near(c("leg_left_cube").from, [-4, 0, -2]) && near(g("leg_left").origin, [-2, 12, 0]) && near(c("leg_right_cube").from, [0, 0, -2]) && near(g("leg_right").origin, [2, 12, 0]));
check("parents are declared before their children (create_cubes order)", plan.groups.every((x, i) => !x.parent || plan.groups.slice(0, i).some((y) => y.name === x.parent)));
const snout = planSpec([...HUMANOID.slice(0, 2), { name: "snout", size: [4, 3, 3], parent: "head", attach: { to: "head", side: "front", align: { y: "min" }, offset: [0, 1, 0] } }]);
check("attach with a per-axis align: the snout centred in x, low on the face", near(snout.cubes[2].from, [-2, 25, -7]), JSON.stringify(snout.cubes[2]));
check("default placement: centred on the origin, standing on y = 0", near(planSpec([{ name: "crate", size: [6, 4, 2] }]).cubes[0].from, [-3, 0, -1]));
check("Java: the mirror plane is x = 8", near(planSpec([{ name: "post_left", size: [2, 8, 2], from: [10, 0, 7], mirror: "x" }], {}, new Set(), 8).cubes[1].from, [4, 0, 7]));

const err = (parts, existing, groups) => planSpec(parts, existing, groups).error || "";
check("attach to a later part is refused", /neither an earlier part nor an existing element/.test(err([{ name: "a", size: [1, 1, 1], attach: { to: "b", side: "left" } }, { name: "b", size: [1, 1, 1] }])));
check("a name used twice is refused", /used twice/.test(err([{ name: "a", size: [1, 1, 1] }, { name: "a", size: [2, 2, 2] }])));
check("mirror without a side in the name is refused", /needs a side in the name/.test(err([{ name: "tail", size: [1, 1, 1], mirror: "x" }])));
check("an unknown parent is refused", /parent "nope"/.test(err([{ name: "a", size: [1, 1, 1], parent: "nope" }])));
check("a name that already exists in the project is refused", /already exists in the project/.test(err([{ name: "body", size: [1, 1, 1] }], { body: { min: [0, 0, 0], max: [1, 1, 1] } })));
check("attach and from together are refused", /attach or from/.test(err([{ name: "a", size: [1, 1, 1], from: [0, 0, 0], attach: { to: "x", side: "left" } }])));

const boxes = sceneBoxes({ roots: [{ type: "group", name: "g", origin: [0, 0, 0], rotation: [0, 0, 90], children: [{ type: "cube", name: "c", from: [0, 0, 0], to: [2, 1, 1], origin: [0, 0, 0], rotation: [0, 0, 0] }] }] });
check("sceneBoxes measures existing parts with their rotations", near(boxes.c.min, [-1, 0, 0]) && near(boxes.c.max, [0, 2, 1]) && near(boxes.g.min, [-1, 0, 0]));

console.log("\n--- templates ---");
const hum = planSpec(templateParts("humanoid"));
const hc = (n) => hum.cubes.find((x) => x.name === n), hg = (n) => hum.groups.find((x) => x.name === n);
check("humanoid: Minecraft proportions, left limbs at −X, pivots at hips / shoulders / neck",
  near(hc("head_cube").from, [-4, 24, -4]) && near(hc("arm_left_cube").from, [-8, 12, -2]) && near(hg("arm_left").origin, [-6, 24, 0]) &&
  near(hc("leg_left_cube").from, [-4, 0, -2]) && near(hg("leg_left").origin, [-2, 12, 0]) && near(hc("leg_right_cube").from, [0, 0, -2]) && near(hg("head").origin, [0, 24, 0]),
  hum.groups.map((g) => g.name).join(", "));
const big = planSpec(templateParts("humanoid", 2));
check("humanoid at scale 2: twice the size, still standing on y = 0",
  near(big.cubes.find((x) => x.name === "body_cube").to, [8, 48, 4]) && near(big.cubes.find((x) => x.name === "leg_left_cube").from, [-8, 0, -4]));
const quadPlan = planSpec(templateParts("quadruped"));
const qc = (n) => quadPlan.cubes.find((x) => x.name === n);
check("quadruped: legs at the body's corners, head in front, tail behind",
  near(qc("leg_front_left_cube").from, [-4, 0, -8]) && near(qc("leg_back_right_cube").to, [4, 8, 8]) && qc("head_cube").to[2] === -7 && qc("tail_cube").from[2] === 8,
  JSON.stringify([qc("head_cube"), qc("tail_cube")]));
const sword = planSpec(templateParts("sword"));
const sc = (n) => sword.cubes.find((x) => x.name === n);
check("sword: guard on the grip, blade on the guard, pommel under the grip",
  near(sc("guard_cube").from, [-4, 6, -1]) && near(sc("blade_cube").from, [-1, 7, -0.5]) && near(sc("blade_cube").to, [1, 23, 0.5]) && near(sc("pommel_cube").from, [-2, -2, -2]),
  JSON.stringify(sword.cubes));
const chain = planSpec(templateParts("chain"));
const cc = (n) => chain.cubes.find((x) => x.name === n), cg = (n) => chain.groups.find((x) => x.name === n);
check("chain: 4 segments one behind the other (+Z), each inside the one before, pivoting at its front",
  chain.groups.length === 4 && near(cc("segment_1_cube").from, [-1, 0, 0]) && near(cc("segment_2_cube").from, [-1, 0, 4]) && near(cc("segment_4_cube").to, [1, 2, 16]) &&
  !cg("segment_1").parent && cg("segment_2").parent === "segment_1" && cg("segment_4").parent === "segment_3" &&
  [1, 2, 3, 4].every((k) => near(cg(`segment_${k}`).origin, [0, 1, 4 * (k - 1)])),
  JSON.stringify(chain.groups));
check("chain: segments sets its length, scale its size",
  planSpec(templateParts("chain", 1, 6)).groups.length === 6 && near(planSpec(templateParts("chain", 2)).cubes[0].to, [2, 4, 8]));

console.log("\n--- through the server (mock Blockbench) ---");
const h = await startHarness();
try {
  const node = (name) => { let r = null; const walk = (ns) => ns.forEach((n) => { if (n.name === name) r = n; if (n.children) walk(n.children); }); walk(h.scene.roots); return r; };
  const strict = await h.call("create_from_spec", { parts: HUMANOID });
  check("the format's rotation rules still apply (legacy rules: one axis per bone), nothing is built", strict.isError && /ILLEGAL_ROTATION/.test(strict.text) && !node("body"), strict.text.slice(0, 120));
  h.mock.setFormat({ id: "geckolib_model", bone_rig: true, rotate_cubes: true }); // GeckoLib: bones on any axes
  const quadPlanned = await h.call("create_from_spec", { template: "quadruped", scale: 0.5, dry_run: true });
  check("a template alone, scaled, as a plan", !quadPlanned.isError && /Plan \(nothing created\): 7 bone\(s\), 7 cube\(s\)/.test(quadPlanned.text), quadPlanned.text.split("\n")[0]);
  const neither = await h.call("create_from_spec", {});
  check("neither parts nor a template is refused", neither.isError && /give parts, a template, or both/.test(neither.text), neither.text);
  const chainPlanned = await h.call("create_from_spec", { template: "chain", segments: 5, dry_run: true });
  check("a chain of 5 segments as a plan", !chainPlanned.isError && /Plan \(nothing created\): 5 bone\(s\), 5 cube\(s\)/.test(chainPlanned.text) && /segment_5\/ \(in segment_4\)/.test(chainPlanned.text), chainPlanned.text.split("\n")[0]);
  const stray = await h.call("create_from_spec", { template: "humanoid", segments: 5, dry_run: true });
  check("segments with another template is refused", stray.isError && /^\[INVALID_INPUT\] .*segments is invalid without template "chain"/.test(stray.text), stray.text);
  const dry = await h.call("create_from_spec", { parts: HUMANOID, dry_run: true });
  check("dry_run shows the plan and creates nothing", !dry.isError && /Plan \(nothing created\): 8 bone\(s\), 8 cube\(s\)/.test(dry.text) && !node("body"), dry.text.split("\n")[0]);
  const built = await h.call("create_from_spec", { parts: HUMANOID });
  check("the whole humanoid in one call", !built.isError && /Built 8 bone\(s\) with 8 cube\(s\) in one undo step/.test(built.text) && /Next: pack_uv/.test(built.text), built.text.split("\n")[0]);
  check("…and it is in the scene as planned", near(node("arm_right_cube")?.from, [4, 12, -2]) && !!node("arm_right")?.children?.find((x) => x.name === "hand_right"));
  const hat = await h.call("create_from_spec", { parts: [{ name: "hat", size: [10, 2, 10], parent: "head", attach: { to: "head", side: "on_top", gap: -1 } }] });
  check("a new part can rest on an existing one", !hat.isError && near(node("hat_cube")?.from, [-5, 31, -5]), hat.text.split("\n").slice(0, 2).join(" ⏎ "));
  const clash = await h.call("create_from_spec", { parts: [{ name: "head", size: [1, 1, 1] }] });
  check("a clash with an existing name is refused with a code", clash.isError && /^\[DUPLICATE_NAME\]/.test(clash.text), clash.text);
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 SPEC CHECKS PASSED" : "💥 " + failures + " SPEC CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
