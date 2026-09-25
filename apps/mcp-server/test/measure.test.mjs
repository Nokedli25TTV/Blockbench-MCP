// measure: the box relations (packages/shared/src/measure.ts, straight from the TypeScript
// source) and the tool through the server and the mock — a humanoid measured part by part.
import { boxRelation, relationText, boxSize } from "../../../packages/shared/src/measure.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const one = (s) => s.replace(/\n/g, " ⏎ ").slice(0, 360);
const J = JSON.stringify;
const B = (min, max) => ({ min, max });

console.log("--- relations ---");
const body = B([-4, 12, -2], [4, 24, 2]), head = B([-4, 24, -4], [4, 32, 4]), hat = B([-5, 31, -5], [5, 33, 5]);
let r = boxRelation(B([-8, 12, -2], [-4, 24, 2]), body);
check("side by side: touching, on the model's own left (−X)", r.state === "touching" && r.side === "left" && r.axis === "x" && r.distance === 0, J(r));
r = boxRelation(head, body);
check("resting on it: touching on y, on_top", r.state === "touching" && r.side === "on_top" && r.axis === "y", J(r));
r = boxRelation(hat, head);
check("sunk in by 1: overlapping 1 deep on y, with the shared box and its volume", r.state === "overlapping" && r.side === "on_top" && r.gap[1] === -1 && J(r.shared) === J({ box: B([-4, 31, -4], [4, 32, 4]), volume: 64 }), J(r));
r = boxRelation(B([-4, 0, -2], [0, 9, 2]), body);
check("a gap below: apart, 3 on y", r.state === "apart" && r.side === "below" && r.distance === 3 && r.gap[1] === 3, J(r));
r = boxRelation(B([6, 26, 3], [8, 28, 5]), body);
check("apart on a diagonal: the distance over every axis's gap", r.state === "apart" && r.distance === 3 && J(r.gap) === J([2, 2, 1]), J(r));
const core = B([-1, 15, -1], [1, 17, 1]);
check("within: inside — and the other way round: contains", boxRelation(core, body).side === "inside" && boxRelation(body, core).contains && boxRelation(body, core).side === null);
check("front is −Z, back +Z", boxRelation(B([-1, 14, -5], [1, 16, -2]), body).side === "front" && boxRelation(B([-1, 14, 2], [1, 16, 5]), body).side === "back");
check("one line per pair",
  relationText("arm", "body", boxRelation(B([-8, 12, -2], [-4, 24, 2]), body)) === "arm → body: left, touching on x" &&
  relationText("hat", "head", boxRelation(hat, head)) === "hat → head: on_top, OVERLAPPING — 1 deep on y (shared [-4, 31, -4]→[4, 32, 4], volume 64)" &&
  relationText("far", "body", boxRelation(B([6, 26, 3], [8, 28, 5]), body)) === "far → body: right, apart — distance 3 (2 on x, 2 on y, 1 on z)" &&
  relationText("body", "core", boxRelation(body, core)).startsWith("body → core: contains it — core is within body"));
check("boxSize", J(boxSize(body)) === J([8, 12, 4]));

console.log("\n--- through the server (mock Blockbench) ---");
// No rotations, so every box is exact. The model faces north: front = −Z, its own left = −X.
const PARTS = [
  { name: "body", size: [8, 12, 4], from: [-4, 12, -2], pivot: "bottom" },
  { name: "head", size: [8, 8, 8], parent: "body", attach: { to: "body", side: "on_top" }, pivot: "bottom" },
  { name: "hat", size: [10, 2, 10], parent: "head", attach: { to: "head", side: "on_top", gap: -1 } },
  { name: "arm_left", size: [4, 12, 4], parent: "body", attach: { to: "body", side: "left", align: "max" }, pivot: "top", mirror: "x" },
  { name: "leg_left", size: [4, 12, 4], attach: { to: "body", side: "below", align: "min" }, pivot: "top", mirror: "x" },
];
const h = await startHarness();
try {
  h.mock.setFormat({ id: "geckolib_model", bone_rig: true, rotate_cubes: true });
  const built = await h.call("create_from_spec", { parts: PARTS });
  check("a humanoid with a hat sunk 1 into its head", !built.isError, one(built.text));

  let t = await h.call("measure", { targets: ["arm_left_cube", "body_cube"] });
  check("two cubes: each box with its size and centre, at rest",
    !t.isError && /^Measured at rest/.test(t.text) && /arm_left_cube  \[-8, 12, -2\]→\[-4, 24, 2\]  size 4 × 12 × 4  centre \[-6, 18, 0\]/.test(t.text) && /body_cube  \[-4, 12, -2\]→\[4, 24, 2\]/.test(t.text), one(t.text));
  check("…and the arm on the body's left, touching", /arm_left_cube → body_cube: left, touching on x/.test(t.text), one(t.text));

  t = await h.call("measure", { targets: ["head", "body_cube", "leg_right_cube"] });
  check("a group's box holds everything in it (the head with its hat); groups end in /", !t.isError && /head\/  \[-5, 24, -5\]→\[5, 33, 5\]/.test(t.text), one(t.text));
  check("…every pair once: on_top touching, apart by the gap",
    /head\/ → body_cube: on_top, touching on y/.test(t.text) && /head\/ → leg_right_cube: on_top, apart — 12 on y/.test(t.text) && /body_cube → leg_right_cube: on_top, touching on y/.test(t.text) && (t.text.match(/^ {2}\S.* → /gm) || []).length === 3, one(t.text));

  t = await h.call("measure", { targets: ["hat_cube", "head_cube"] });
  check("the sunk hat: OVERLAPPING 1 deep, with the shared box", /hat_cube → head_cube: on_top, OVERLAPPING — 1 deep on y \(shared \[-4, 31, -4\]→\[4, 32, 4\], volume 64\)/.test(t.text), one(t.text));

  t = await h.call("measure", {});
  check("no targets: the whole model", !t.isError && /\(whole model\)  \[-8, 0, -5\]→\[8, 33, 5\]  size 16 × 33 × 10/.test(t.text) && !/Pairs/.test(t.text), one(t.text));
  t = await h.call("measure", { targets: ["body_cube", "body_cube"] });
  check("a name given twice is measured once", !t.isError && (t.text.match(/body_cube  \[/g) || []).length === 1 && !/Pairs/.test(t.text), one(t.text));

  await h.call("set_rotation", { target: "arm_left", rotation: [0, 0, 90] });
  t = await h.call("measure", { targets: ["arm_left_cube", "body_cube"] });
  check("rotations count: the arm swung up about its shoulder now reaches 2 into the body",
    /arm_left_cube  \[-6, 22, -2\]→\[6, 26, 2\]/.test(t.text) && /arm_left_cube → body_cube: on_top, OVERLAPPING — 2 deep on y/.test(t.text), one(t.text));

  t = await h.call("measure", { targets: ["nope"] });
  check("an unknown part: NOT_FOUND", t.isError && /^\[NOT_FOUND\] measure failed: "nope" not found/.test(t.text), t.text);
  t = await h.call("measure", { targets: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
  check("more than 8 targets are refused by the schema", t.isError, t.text.slice(0, 100));
  t = await h.call("measure", { targets: ["leg_left_cube"], time: 0.5 });
  check("time without an animation: says so", t.isError && /No animation selected/.test(t.text), t.text);
  await h.call("create_animation", { name: "walk", animation_length: 1, loop: true, bones: { leg_left: [{ time: 0, rotation: [0, 0, 0] }] } });
  t = await h.call("measure", { targets: ["leg_left_cube", "body_cube"], time: 0.5 });
  check("time: measured at that moment of the animation", !t.isError && /^Measured at 0\.5s of animation\.walk/.test(t.text) && /leg_left_cube → body_cube: below, touching on y/.test(t.text), one(t.text));
  h.mock.setFormat({ id: "java_block", bone_rig: false, rotate_cubes: true, java_block_version: "1.9.0", coordinate_limits: [-16, 32] });
  t = await h.call("measure", { targets: ["body_cube"], time: 0.5 });
  check("time in a format without animations: FORMAT_UNSUPPORTED", t.isError && /^\[FORMAT_UNSUPPORTED\]/.test(t.text), t.text);
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 MEASURE CHECKS PASSED" : "💥 " + failures + " MEASURE CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
