// Placement tools: the shared math (packages/shared/src/placement.ts, straight from the
// TypeScript source) and the tools end to end — move_element, place_relative, set_origin
// anchors, mirrored and repeated duplicate_element — through the real server and the mock.
import {
  rotateAbout, unrotateVector, worldPoints, boxOf, toModelDelta, placementDelta, anchorPoint, mirroredName,
} from "../../../packages/shared/src/placement.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const fmt = (v) => JSON.stringify(v);

console.log("--- shared math ---");
check("Z rotation turns +X into +Y", near(rotateAbout([1, 0, 0], [0, 0, 0], [0, 0, 90]), [0, 1, 0]));
check("Y rotation turns +X into −Z", near(rotateAbout([1, 0, 0], [0, 0, 0], [0, 90, 0]), [0, 0, -1]));
check("X rotation turns +Y into +Z", near(rotateAbout([0, 1, 0], [0, 0, 0], [90, 0, 0]), [0, 0, 1]));
// ZYX = X first: +X survives the X turn, then Y takes it to −Z (XYZ order would end at +Y).
check("Euler order ZYX (X first, then Y, then Z), as Blockbench", near(rotateAbout([1, 0, 0], [0, 0, 0], [90, 90, 0]), [0, 0, -1]));
check("rotation happens about the origin", near(rotateAbout([2, 0, 0], [1, 0, 0], [0, 0, 90]), [1, 1, 0]));
const v = [0.3, -1.7, 2.2], r = [17, -48, 131];
check("unrotateVector undoes rotateAbout", near(unrotateVector(rotateAbout(v, [0, 0, 0], r), r), v, 1e-9));

const tilted = { name: "g", kind: "group", origin: [0, 0, 0], rotation: [0, 0, 90], children: [{ name: "c", kind: "cube", origin: [0, 0, 0], rotation: [0, 0, 0], from: [0, 0, 0], to: [2, 1, 1] }] };
const tb = boxOf(worldPoints(tilted));
check("a cube inside a rotated group is measured rotated", near(tb.min, [-1, 0, 0]) && near(tb.max, [0, 2, 1]), `${fmt(tb.min)}→${fmt(tb.max)}`);
check("a world move is undone through rotated parents", near(toModelDelta([0, 2, 0], [{ origin: [0, 0, 0], rotation: [0, 0, 90] }]), [2, 0, 0]));

const body = { min: [-4, 12, -2], max: [4, 24, 2] }, head = { min: [-3, 0, -3], max: [3, 6, 3] };
check("on_top: centred, resting on the top", near(placementDelta(head, body, "on_top"), [0, 24, 0]));
check("gap keeps a space", near(placementDelta(head, body, "on_top", { gap: 1 }), [0, 25, 0]));
check("left is −X (the model's own left, facing north), centred on the other axes", near(placementDelta(head, body, "left"), [-7, 15, 0]));
check("front is −Z", near(placementDelta(head, body, "front"), [0, 15, -5]));
check("inside + align min: flush with ref's lower corner", near(placementDelta(head, body, "inside", { align: "min" }), [-1, 12, 1]));
check("align keep only moves along the side's axis", near(placementDelta(head, body, "below", { align: "keep" }), [0, 6, 0]));
check("align per axis: { y: \"min\" } is flush at the bottom, x stays centred", near(placementDelta(head, body, "front", { align: { y: "min" } }), [0, 12, -5]));

const arm = { min: [4, 12, -2], max: [8, 24, 2] };
check("anchor top = centre of the top side", near(anchorPoint(arm, "top"), [6, 24, 0]));
check("anchor bottom / left (−X) / right / front", near(anchorPoint(arm, "bottom"), [6, 12, 0]) && near(anchorPoint(arm, "left"), [4, 18, 0]) && near(anchorPoint(arm, "right"), [8, 18, 0]) && near(anchorPoint(arm, "front"), [6, 18, -2]));

const names = [["left_arm", 0, "right_arm"], ["arm_L", 0, "arm_R"], ["armLeft", 0, "armRight"], ["l_leg", 0, "r_leg"], ["body", 0, "body"],
  ["clarinet", 0, "clarinet"], ["top_fin", 1, "bottom_fin"], ["front_leg", 2, "back_leg"], ["rearLeg", 2, "frontLeg"]];
for (const [n, axis, want] of names) check(`mirrored name: ${n} → ${want}`, mirroredName(n, axis) === want, mirroredName(n, axis));

console.log("\n--- tools through the server (mock Blockbench) ---");
const h = await startHarness();
try {
  const call = async (name, args) => h.call(name, args);
  const cube = (name) => { let r = null; const walk = (ns) => ns.forEach((n) => { if (n.name === name) r = n; if (n.children) walk(n.children); }); walk(h.scene.roots); return r; };
  await call("create_project", { format: "geckolib", name: "placement_test" });
  await call("create_group", { name: "body", origin: [0, 12, 0] });
  await call("create_cube", { name: "body_cube", parent: "body", from: [-4, 12, -2], to: [4, 24, 2] });
  await call("create_group", { name: "head", origin: [0, 0, 0] });
  await call("create_cube", { name: "head_cube", parent: "head", from: [-3, 0, -3], to: [3, 6, 3] });

  const dry = await call("place_relative", { target: "head", ref: "body", side: "on_top", dry_run: true });
  check("place_relative dry_run reports and changes nothing", !dry.isError && /Would place/.test(dry.text) && near(cube("head_cube").from, [-3, 0, -3]), dry.text);
  const placed = await call("place_relative", { target: "head", ref: "body", side: "on_top" });
  check("place_relative: head on top of the body, centred", !placed.isError && near(cube("head_cube").from, [-3, 24, -3]) && near(cube("head_cube").to, [3, 30, 3]), placed.text);
  check("the head's pivot moved with it", near(cube("head").origin, [0, 24, 0]), fmt(cube("head").origin));
  const inside = await call("place_relative", { target: "body", ref: "body_cube", side: "on_top" });
  check("placing against a part inside the target is refused", inside.isError && /inside/.test(inside.text), inside.text);
  const perAxis = await call("place_relative", { target: "head", ref: "body", side: "front", align: { y: "max" }, dry_run: true });
  check("place_relative takes a per-axis align", !perAxis.isError && perAxis.text.includes("would span [-3, 18, -8]→[3, 24, -2]"), perAxis.text);
  const badSide = await call("place_relative", { target: "head", ref: "body", side: "above" });
  check("an unknown side is refused by the schema", badSide.isError, badSide.text.slice(0, 120));

  const moved = await call("move_element", { target: "head", offset: [0, 1, 0] });
  check("move_element moves a group with its cubes and pivot", !moved.isError && near(cube("head_cube").from, [-3, 25, -3]) && near(cube("head").origin, [0, 25, 0]), moved.text);
  const movedTo = await call("move_element", { target: "head", to: [0, 24, 0] });
  check("move_element to: puts the pivot at a point", !movedTo.isError && near(cube("head").origin, [0, 24, 0]) && near(cube("head_cube").from, [-3, 24, -3]), movedTo.text);
  const both = await call("move_element", { target: "head", offset: [1, 0, 0], to: [0, 0, 0] });
  check("move_element needs exactly one of offset / to", both.isError, both.text);

  await call("create_group", { name: "tilted", origin: [0, 0, 0], rotation: [0, 0, 90] });
  await call("create_cube", { name: "tilted_cube", parent: "tilted", from: [0, 0, 0], to: [2, 1, 1] });
  const tiltMove = await call("move_element", { target: "tilted_cube", offset: [0, 2, 0] });
  check("a world move inside a rotated group becomes the right model move", !tiltMove.isError && near(cube("tilted_cube").from, [2, 0, 0]), `${tiltMove.text} from=${fmt(cube("tilted_cube").from)}`);

  await call("create_group", { name: "arm_left", origin: [0, 0, 0] });
  await call("create_cube", { name: "arm_left_cube", parent: "arm_left", from: [4, 12, -2], to: [8, 24, 2] });
  const anchored = await call("set_origin", { target: "arm_left", anchor: "top" });
  check("set_origin anchor top: the shoulder pivot", !anchored.isError && near(cube("arm_left").origin, [6, 24, 0]), anchored.text);
  const twice = await call("set_origin", { target: "arm_left", anchor: "top", origin: [0, 0, 0] });
  check("origin and anchor together are refused", twice.isError, twice.text);
  await call("set_rotation", { target: "arm_left", rotation: [0, 0, 10] });

  const mirrored = await call("duplicate_element", { id: "arm_left", mirror: "x" });
  const right = cube("arm_right"), rightCube = cube("arm_right_cube");
  check("mirror: the copy takes the other side's names", !mirrored.isError && !!right && !!rightCube, mirrored.text);
  check("mirror: geometry and pivot mirrored across x = 0", !!rightCube && near(rightCube.from, [-8, 12, -2]) && near(rightCube.to, [-4, 24, 2]) && near(right.origin, [-6, 24, 0]),
    rightCube ? `${fmt(rightCube.from)}→${fmt(rightCube.to)}, pivot ${fmt(right.origin)}` : "missing");
  check("mirror: the rotation turns the other way", !!right && near(right.rotation, [0, 0, -10]), right && fmt(right.rotation));
  check("mirror: box UV mirrored like Blockbench's Flip", !!rightCube && rightCube.mirror_uv === true);

  await call("create_cube", { name: "spike", from: [0, 0, 0], to: [1, 2, 1] });
  const row = await call("duplicate_element", { id: "spike", count: 3, offset: [2, 0, 0], newName: "spike_{i}" });
  check("count: a row of copies, each offset further", !row.isError && near(cube("spike_1").from, [2, 0, 0]) && near(cube("spike_3").from, [6, 0, 0]), row.text);
  const noPattern = await call("duplicate_element", { id: "spike", count: 2, newName: "spike_x" });
  check("count > 1 with a fixed newName is refused (names must stay unique)", noPattern.isError, noPattern.text);

  // The mock keeps one scene; switch its rules the way the other suites do.
  h.mock.setFormat({ id: "java_block", bone_rig: false, rotate_cubes: true, java_block_version: "1.9.0", coordinate_limits: [-16, 32] });
  await call("create_group", { name: "java_root", origin: [0, 0, 0] });
  await call("create_cube", { name: "block", parent: "java_root", from: [0, 0, 0], to: [16, 16, 16] });
  const out = await call("move_element", { target: "block", offset: [20, 0, 0] });
  check("Java: a move past the -16..32 range is refused, nothing changes", out.isError && /OUT_OF_RANGE/.test(out.text) && near(cube("block").from, [0, 0, 0]), out.text);
  const tooFar = await call("place_relative", { target: "block", ref: "body", side: "back", gap: 20, dry_run: true });
  check("dry_run also refuses a placement outside the range", tooFar.isError && /OUT_OF_RANGE/.test(tooFar.text), tooFar.text.slice(0, 160));
  h.mock.setFormat(null);
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 PLACEMENT CHECKS PASSED" : "💥 " + failures + " PLACEMENT CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
